/**
 * Running a benchmark (docs/SPEC-round-two.md R7).
 *
 * Sequential and cancellable, **grouped by lane**, on one pinned seed.
 * Deliberately free of React and of the store: it takes a `chat` function
 * and a `load` function and returns a `BenchmarkRun`, so every rule below
 * is testable without a server, a provider or a render.
 *
 *   1. **One seed for the whole run**, across every lane and every prompt.
 *      Two lanes on two seeds measure sampling noise, which is the one
 *      thing a benchmark must not do. This is the rule the whole feature
 *      rests on.
 *   2. **Grouped by lane, never interleaved by prompt.** Lane 1's model is
 *      loaded once, every prompt runs against it, and only then does lane 2
 *      load. Interleaving would mean a full model load per prompt — on a
 *      20 GB model, the difference between two loads and twenty.
 *   3. **A failed cell is a result**, kept with its cause, and the run
 *      carries on. A context-length failure in lane 2 is exactly what a
 *      benchmark is for; aborting would throw away the evidence beside it.
 *      A lane whose *model fails to load* fails that lane's cells with the
 *      reason and the run moves to the next lane — one unavailable model
 *      must not cost you the lanes that do work.
 *   4. **Cancel keeps every finished cell** and marks the run `partial`.
 *      The in-flight cell is dropped, because half a streamed answer would
 *      read as "different" for a reason that has nothing to do with the
 *      model.
 *   5. One message per request — no accumulated transcript. A benchmark
 *      measures the answer to a prompt, not the answer to a conversation
 *      that happens to contain it.
 *
 * Only ever one model is resident: the lane's model is loaded, used, and
 * left for the next load to replace (R7, SPEC §8).
 */
import type { ChatChunk, ChatMessage } from "../api/types";
import { newRunId } from "./benchmarks";
import type {
  Benchmark,
  BenchmarkPrompt,
  BenchmarkRun,
  Cell,
  CellStats,
  Lane,
} from "./types";

/** Exactly what the runner needs of an OllamaClient's chat — nothing more. */
export type BenchmarkChat = (
  model: string,
  messages: ChatMessage[],
  opts: { seed: number; signal: AbortSignal },
) => AsyncIterable<ChatChunk>;

/**
 * Bring a lane's model up. Called once per lane, not once per prompt — see
 * rule 2. Resolving means "ready to answer"; throwing means this lane
 * cannot run, which is a result for the lane rather than the end of the run.
 */
export type BenchmarkLoad = (model: string, signal: AbortSignal) => Promise<void>;

/**
 * What the run is doing right now. R7 asks for the load to be *visible* —
 * "Loading qwen3.8-27b (lane 2 of 2)" rather than a UI that looks hung for
 * a minute — so the loading phase is reported, not swallowed.
 */
export interface BenchmarkProgress {
  phase: "loading" | "answering";
  lane: Lane;
  /** 1-based, for "lane 2 of 3". */
  laneNumber: number;
  laneCount: number;
  /** The prompt in flight; null during the load. */
  prompt: BenchmarkPrompt | null;
  /** Cells settled so far, and how many there will be in total. */
  done: number;
  total: number;
}

export interface RunBenchmarkArgs {
  benchmark: Benchmark;
  /** Pinned for the whole run. The caller draws it once. */
  seed: number;
  signal: AbortSignal;
  chat: BenchmarkChat;
  load: BenchmarkLoad;
  /** Injectable for tests; default to the wall clock. */
  now?: () => number;
  clock?: () => Date;
  onProgress?: (progress: BenchmarkProgress) => void;
  /** Called as each cell settles, so the table can fill in live. */
  onCell?: (cell: Cell, done: number, total: number) => void;
}

function statsFrom(chunkStats: ChatChunk["stats"], ms: number): CellStats {
  if (chunkStats === undefined) return { evalCount: 0, tokPerSec: null, ms };
  const tokPerSec =
    chunkStats.evalDurationNs > 0
      ? Math.round(chunkStats.evalCount / (chunkStats.evalDurationNs / 1e9))
      : null;
  return { evalCount: chunkStats.evalCount, tokPerSec, ms };
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === "AbortError");
}

/** SPEC §9: the server's text, verbatim — never a rewritten summary of it. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runBenchmark({
  benchmark,
  seed,
  signal,
  chat,
  load,
  now = () => Date.now(),
  clock = () => new Date(),
  onProgress,
  onCell,
}: RunBenchmarkArgs): Promise<BenchmarkRun> {
  const cells: Cell[] = [];
  const laneCount = benchmark.lanes.length;
  const total = benchmark.prompts.length * laneCount;
  let cancelled = signal.aborted;

  const settle = (cell: Cell): void => {
    cells.push(cell);
    onCell?.(cell, cells.length, total);
  };

  // No prompts is not a run to load a model for. Skipping the loop entirely
  // keeps "run an empty benchmark" from costing a model load.
  lanes: for (const [laneIndex, lane] of benchmark.lanes.entries()) {
    if (benchmark.prompts.length === 0) break;
    if (signal.aborted) {
      cancelled = true;
      break;
    }
    onProgress?.({
      phase: "loading",
      lane,
      laneNumber: laneIndex + 1,
      laneCount,
      prompt: null,
      done: cells.length,
      total,
    });

    // Rule 2: exactly one load per lane, before any of its prompts.
    let loadFailure: string | null = null;
    try {
      await load(lane.model, signal);
    } catch (err) {
      if (isAbort(err, signal)) {
        cancelled = true;
        break;
      }
      loadFailure = messageOf(err);
    }
    if (loadFailure === null && signal.aborted) {
      cancelled = true;
      break;
    }

    if (loadFailure !== null) {
      // Rule 3: the lane failed, not the run. Every cell of this lane
      // carries the load's own reason — "model not found" against each
      // prompt is honest, and leaving them blank would read as "not run".
      for (const prompt of benchmark.prompts) {
        settle({ promptId: prompt.id, laneId: lane.id, content: "", error: loadFailure });
      }
      continue;
    }

    for (const prompt of benchmark.prompts) {
      if (signal.aborted) {
        cancelled = true;
        break lanes;
      }
      onProgress?.({
        phase: "answering",
        lane,
        laneNumber: laneIndex + 1,
        laneCount,
        prompt,
        done: cells.length,
        total,
      });

      const started = now();
      let content = "";
      let thinking = "";
      let stats: ChatChunk["stats"];
      let failure: string | null = null;
      try {
        // Rule 5: one user message, every time.
        for await (const chunk of chat(lane.model, [{ role: "user", content: prompt.text }], {
          seed,
          signal,
        })) {
          content += chunk.content;
          if (chunk.thinking !== undefined) thinking += chunk.thinking;
          if (chunk.done && chunk.stats !== undefined) stats = chunk.stats;
        }
      } catch (err) {
        if (isAbort(err, signal)) {
          // Rule 4: the in-flight cell is not a finished cell.
          cancelled = true;
          break lanes;
        }
        failure = messageOf(err);
      }
      // A cancel that landed between the last chunk and here is still a
      // cancel: the answer may be truncated, so it does not become a cell.
      if (failure === null && signal.aborted) {
        cancelled = true;
        break lanes;
      }

      const cell: Cell = { promptId: prompt.id, laneId: lane.id, content };
      if (thinking !== "") cell.thinking = thinking;
      if (failure !== null) cell.error = failure;
      else cell.stats = statsFrom(stats, now() - started);
      settle(cell);
    }
  }

  return {
    id: newRunId(clock()),
    ranAt: clock().toISOString(),
    seed,
    // Cancelled, or short of a cell for every lane × prompt either way.
    partial: cancelled || cells.length < total,
    cells,
  };
}
