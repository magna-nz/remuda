/**
 * Replaying a bench (docs/SPEC-tuning.md T5, docs/SPEC-round-two.md R4).
 *
 * Sequential and cancellable, one prompt at a time, on **one pinned seed**.
 * Deliberately free of React and of the store: it takes a `chat` function
 * and returns a `BenchRun`, so the four rules below are testable without a
 * server, a provider or a render.
 *
 *   1. One seed across every prompt. Two prompts on two seeds measure
 *      sampling noise, which is the one thing a regression set must not do.
 *   2. A failed prompt is a *result*, kept with its cause, and the run
 *      carries on. A context-length failure on prompt 3 is exactly what the
 *      bench is for; aborting the remaining prompts would throw away the
 *      evidence next to it.
 *   3. Cancel keeps every finished row and marks the run `partial`. The row
 *      that was mid-flight is dropped, because half an answer would diff as
 *      `changed` for a reason that has nothing to do with the model.
 *   4. Prompts are sent one message at a time — no accumulated transcript.
 *      A bench measures the model's answer to a prompt, not its answer to a
 *      conversation that happens to contain it.
 */
import type { ChatChunk, ChatMessage } from "../api/types";
import {
  newRunId,
  type Bench,
  type BenchResult,
  type BenchRun,
  type BenchStats,
} from "./benches";

/** Exactly what the runner needs of an OllamaClient — nothing more. */
export type BenchChat = (
  messages: ChatMessage[],
  opts: { seed: number; signal: AbortSignal },
) => AsyncIterable<ChatChunk>;

export interface RunBenchArgs {
  bench: Bench;
  /** Pinned for the whole run. The caller draws it once. */
  seed: number;
  /** The T1 Modelfile snapshot the run is made against; null when unknown. */
  snapshotId: string | null;
  signal: AbortSignal;
  chat: BenchChat;
  /** Injectable for tests; defaults to the wall clock. */
  now?: () => number;
  clock?: () => Date;
  /** Called after each prompt settles, so the table can fill in live. */
  onResult?: (result: BenchResult, done: number, total: number) => void;
}

function statsFrom(chunkStats: ChatChunk["stats"], ms: number): BenchStats {
  if (chunkStats === undefined) return { evalCount: 0, tokPerSec: null, ms };
  const tokPerSec =
    chunkStats.evalDurationNs > 0
      ? Math.round(chunkStats.evalCount / (chunkStats.evalDurationNs / 1e9))
      : null;
  return { evalCount: chunkStats.evalCount, tokPerSec, ms };
}

export async function runBench({
  bench,
  seed,
  snapshotId,
  signal,
  chat,
  now = () => Date.now(),
  clock = () => new Date(),
  onResult,
}: RunBenchArgs): Promise<BenchRun> {
  const results: BenchResult[] = [];
  const total = bench.prompts.length;
  let cancelled = signal.aborted;

  for (const prompt of bench.prompts) {
    if (signal.aborted) {
      cancelled = true;
      break;
    }
    const started = now();
    let content = "";
    let thinking = "";
    let stats: ChatChunk["stats"];
    let failure: string | null = null;
    try {
      for await (const chunk of chat([{ role: "user", content: prompt.text }], {
        seed,
        signal,
      })) {
        content += chunk.content;
        if (chunk.thinking !== undefined) thinking += chunk.thinking;
        if (chunk.done && chunk.stats !== undefined) stats = chunk.stats;
      }
    } catch (err) {
      const aborted = signal.aborted || (err instanceof Error && err.name === "AbortError");
      if (aborted) {
        // Rule 3: the in-flight row is not a finished row.
        cancelled = true;
        break;
      }
      // Rule 2: SPEC §9 — verbatim, kept, and not the end of the run.
      failure = err instanceof Error ? err.message : String(err);
    }
    // A cancel that landed between the last chunk and here is still a
    // cancel: the answer may be truncated, so it does not become a row.
    if (failure === null && signal.aborted) {
      cancelled = true;
      break;
    }

    const result: BenchResult = { promptId: prompt.id, content };
    if (thinking !== "") result.thinking = thinking;
    if (failure !== null) result.error = failure;
    else result.stats = statsFrom(stats, now() - started);
    results.push(result);
    onResult?.(result, results.length, total);
  }

  return {
    id: newRunId(clock()),
    ranAt: clock().toISOString(),
    snapshotId,
    seed,
    // Cancelled, or short of a result for every prompt either way.
    partial: cancelled || results.length < total,
    results,
  };
}
