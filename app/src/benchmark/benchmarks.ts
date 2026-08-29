/**
 * The benchmark store (docs/SPEC-round-two.md R7): editing, the run ring,
 * persistence, and the one-way migration from R4's benches.
 *
 * The shapes live in `types.ts` and are not restated here. This file holds
 * the operations on them, all pure and all returning new values — the same
 * register as `chat/sessions.ts` and R4's `bench/benches.ts`: a versioned
 * key, pure load/save, two-tier coercion (a corrupt spine drops the record,
 * a corrupt optional field drops itself), and a try/catch that degrades to
 * an empty list rather than crashing.
 *
 * Nothing here scores, ranks or orders a lane. R7: "different is a diff,
 * not a verdict" — the derivations in rows.ts hold that line, and this file
 * must never hand them a reason to cross it.
 *
 * Composition at the callsite is meant to be:
 *
 *     const stored = loadBenchmarks();
 *     const all = migrateBenches(stored);
 *     if (all !== stored) saveBenchmarks(all);
 *
 * `migrateBenches` neither reads nor writes the benchmark key itself, so
 * the store stays the only writer.
 */
import {
  BENCHMARK_STORAGE_KEY,
  LEGACY_BENCH_STORAGE_KEY,
  MAX_LANES,
  PROSE_CAP,
  RUN_CAP,
  type Benchmark,
  type BenchmarkPrompt,
  type BenchmarkRun,
  type Cell,
  type CellStats,
  type Lane,
} from "./types";

/* ------------------------------------------------------------------- ids */

export function newBenchmarkId(now: Date = new Date()): string {
  return `bm-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newPromptId(now: Date = new Date()): string {
  return `bp-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newLaneId(now: Date = new Date()): string {
  return `ln-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newRunId(now: Date = new Date()): string {
  return `br-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* -------------------------------------------------------------- creating */

/** Cut stored prose to PROSE_CAP, marking the cut so nothing reads as complete. */
export function trimProse(text: string): string {
  if (text.length <= PROSE_CAP) return text;
  return `${text.slice(0, PROSE_CAP)}…`;
}

/**
 * The default name for a benchmark nobody named. Capture must cost nothing
 * (SPEC-tuning T5), so the first prompt captured for a model creates the
 * benchmark outright rather than opening a name dialog.
 */
export function defaultBenchmarkName(model: string): string {
  return `${model.replace(/:latest$/, "")} benchmark`;
}

/**
 * A new benchmark starts with exactly one lane. Zero lanes is not a state
 * the rest of the code has to consider: there would be no column to put an
 * answer in, and `removeLane` refuses to take the last one away.
 */
export function createBenchmark(
  name: string,
  model: string,
  modelfile: string | null = null,
  now: Date = new Date(),
): Benchmark {
  return {
    id: newBenchmarkId(now),
    name,
    prompts: [],
    lanes: [{ id: newLaneId(now), model, modelfile }],
    runs: [],
  };
}

export function renameBenchmark(benchmark: Benchmark, name: string): Benchmark {
  const trimmed = name.trim();
  // A blank rename is a slip, not an instruction to make the rail unreadable.
  if (trimmed === "" || trimmed === benchmark.name) return benchmark;
  return { ...benchmark, name: trimmed };
}

/** Delete by id, out of the list. Confirmation is the caller's (SPEC §8). */
export function deleteBenchmark(benchmarks: Benchmark[], id: string): Benchmark[] {
  if (!benchmarks.some((b) => b.id === id)) return benchmarks;
  return benchmarks.filter((b) => b.id !== id);
}

/* --------------------------------------------------------------- prompts */

/**
 * Append a prompt. Returns `benchmark` unchanged — the same reference —
 * when the exact text is already in it, so pressing "Add to benchmark"
 * twice on one message does not double every lane's work. Blank text adds
 * nothing.
 */
export function addPrompt(
  benchmark: Benchmark,
  text: string,
  now: Date = new Date(),
): Benchmark {
  const trimmed = text.trim();
  if (trimmed === "") return benchmark;
  if (benchmark.prompts.some((p) => p.text === trimmed)) return benchmark;
  return {
    ...benchmark,
    prompts: [...benchmark.prompts, { id: newPromptId(now), text: trimmed }],
  };
}

export function removePrompt(benchmark: Benchmark, promptId: string): Benchmark {
  if (!benchmark.prompts.some((p) => p.id === promptId)) return benchmark;
  return { ...benchmark, prompts: benchmark.prompts.filter((p) => p.id !== promptId) };
}

/* ----------------------------------------------------------------- lanes */

/**
 * Add a lane, up to MAX_LANES. Past the cap the benchmark comes back
 * unchanged: more than four lanes is a full model load each and a table
 * nobody can read side by side.
 *
 * Duplicates are *not* rejected. The same model with two different
 * Modelfiles is the normal setup for this feature, and even the same model
 * twice is a legitimate way to look at run-to-run variance under one seed.
 */
export function addLane(
  benchmark: Benchmark,
  model: string,
  modelfile: string | null = null,
  now: Date = new Date(),
): Benchmark {
  if (benchmark.lanes.length >= MAX_LANES) return benchmark;
  return { ...benchmark, lanes: [...benchmark.lanes, { id: newLaneId(now), model, modelfile }] };
}

/**
 * Remove a lane, never the last one — a benchmark with no lanes cannot be
 * run and cannot be rendered.
 *
 * Past runs keep the removed lane's cells. They are history: the run did
 * happen with that lane in it, and rows.ts renders only the lanes the
 * benchmark currently has, so the stale cells are invisible rather than
 * wrong. Deleting them would silently rewrite what was measured.
 */
export function removeLane(benchmark: Benchmark, laneId: string): Benchmark {
  if (benchmark.lanes.length <= 1) return benchmark;
  if (!benchmark.lanes.some((l) => l.id === laneId)) return benchmark;
  return { ...benchmark, lanes: benchmark.lanes.filter((l) => l.id !== laneId) };
}

/** Point a lane at a different model or variant, keeping its id and place. */
export function updateLane(
  benchmark: Benchmark,
  laneId: string,
  changes: { model?: string; modelfile?: string | null },
): Benchmark {
  const lane = benchmark.lanes.find((l) => l.id === laneId);
  if (lane === undefined) return benchmark;
  const next: Lane = {
    id: lane.id,
    model: changes.model ?? lane.model,
    modelfile: changes.modelfile === undefined ? lane.modelfile : changes.modelfile,
  };
  if (next.model === lane.model && next.modelfile === lane.modelfile) return benchmark;
  return { ...benchmark, lanes: benchmark.lanes.map((l) => (l.id === laneId ? next : l)) };
}

/**
 * Move a lane by `delta` places, clamped at both ends.
 *
 * Order is not decoration: lane 1 is the baseline every other lane is
 * diffed against (rows.ts), and it is the first model loaded. Being able to
 * put a different lane first is how you change what the diff is *from*
 * without retyping the set.
 */
export function moveLane(benchmark: Benchmark, laneId: string, delta: number): Benchmark {
  const from = benchmark.lanes.findIndex((l) => l.id === laneId);
  if (from === -1) return benchmark;
  const to = Math.min(benchmark.lanes.length - 1, Math.max(0, from + delta));
  if (to === from) return benchmark;
  const lanes = [...benchmark.lanes];
  const [moved] = lanes.splice(from, 1);
  lanes.splice(to, 0, moved!);
  return { ...benchmark, lanes };
}

/* ------------------------------------------------------------------ runs */

/**
 * Record a run, newest first, evicting the oldest past RUN_CAP.
 *
 * Prose is trimmed on the way in rather than on the way to storage, so what
 * the table renders is what was persisted: a reload cannot turn a row from
 * `same` into `different` because two answers were cut at different points.
 */
export function appendRun(benchmark: Benchmark, run: BenchmarkRun): Benchmark {
  const stored: BenchmarkRun = {
    ...run,
    cells: run.cells.map((c) => {
      const next: Cell = {
        promptId: c.promptId,
        laneId: c.laneId,
        content: trimProse(c.content),
      };
      if (c.thinking !== undefined) next.thinking = trimProse(c.thinking);
      if (c.stats !== undefined) next.stats = c.stats;
      if (c.error !== undefined) next.error = c.error;
      return next;
    }),
  };
  return { ...benchmark, runs: [stored, ...benchmark.runs].slice(0, RUN_CAP) };
}

/** The run the table shows by default. */
export function latestRun(benchmark: Benchmark): BenchmarkRun | null {
  return benchmark.runs[0] ?? null;
}

/* -------------------------------------------------------------- reading */

function coerceStats(value: unknown): CellStats | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.ms !== "number" || !Number.isFinite(raw.ms)) return undefined;
  // Both counts coerce to null rather than to 0: a payload that lost one is
  // a figure nobody measured, not a figure that measured nothing.
  const evalCount =
    typeof raw.evalCount === "number" && Number.isFinite(raw.evalCount) ? raw.evalCount : null;
  const tokPerSec =
    typeof raw.tokPerSec === "number" && Number.isFinite(raw.tokPerSec) ? raw.tokPerSec : null;
  return { evalCount, tokPerSec, ms: raw.ms };
}

/**
 * Optional tier: a cell whose spine is intact keeps its place even if the
 * stats block is rubbish. `promptId`, `laneId` and `content` are the spine —
 * without all three there is no square of the table to put it in.
 */
function coerceCell(value: unknown): Cell | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.promptId !== "string") return null;
  if (typeof raw.laneId !== "string") return null;
  if (typeof raw.content !== "string") return null;
  const cell: Cell = { promptId: raw.promptId, laneId: raw.laneId, content: raw.content };
  if (typeof raw.thinking === "string") cell.thinking = raw.thinking;
  const stats = coerceStats(raw.stats);
  if (stats !== undefined) cell.stats = stats;
  // An error is the whole reason the cell is interesting; keep it verbatim.
  if (typeof raw.error === "string" && raw.error !== "") cell.error = raw.error;
  return cell;
}

/**
 * Spine tier: id / ranAt / seed / cells. A run with no readable seed is not
 * a run you can compare lanes within, because the pinned seed is the entire
 * basis of the comparison — so it is dropped, alone, without taking the
 * benchmark with it.
 */
function coerceRun(value: unknown): BenchmarkRun | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.ranAt !== "string") return null;
  if (typeof raw.seed !== "number" || !Number.isFinite(raw.seed)) return null;
  if (!Array.isArray(raw.cells)) return null;
  const cells: Cell[] = [];
  for (const entry of raw.cells) {
    const cell = coerceCell(entry);
    if (cell !== null) cells.push(cell);
  }
  return {
    id: raw.id,
    ranAt: raw.ranAt,
    seed: raw.seed,
    // Anything other than an explicit `false` is read as partial: a run
    // whose flag did not survive should under-claim, not over-claim.
    partial: raw.partial !== false,
    cells,
  };
}

function coercePrompt(value: unknown): BenchmarkPrompt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.text !== "string") return null;
  return { id: raw.id, text: raw.text };
}

function coerceLane(value: unknown): Lane | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.model !== "string") return null;
  return {
    id: raw.id,
    model: raw.model,
    // Anything unreadable means "we do not know which variant", which is
    // exactly what the base model reads as. Display only either way.
    modelfile: typeof raw.modelfile === "string" ? raw.modelfile : null,
  };
}

function coerceBenchmark(value: unknown): Benchmark | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    !Array.isArray(raw.prompts) ||
    !Array.isArray(raw.lanes) ||
    !Array.isArray(raw.runs)
  ) {
    return null;
  }
  const prompts: BenchmarkPrompt[] = [];
  for (const entry of raw.prompts) {
    const prompt = coercePrompt(entry);
    // A prompt is the spine of the benchmark: losing one silently would
    // renumber every row and diff answers against the wrong question.
    if (prompt === null) return null;
    prompts.push(prompt);
  }
  const lanes: Lane[] = [];
  for (const entry of raw.lanes) {
    const lane = coerceLane(entry);
    // Same argument as prompts, one axis over: a lost lane would put every
    // cell to its right under the wrong column heading.
    if (lane === null) return null;
    lanes.push(lane);
  }
  // No lanes is no columns: nothing to show and nothing to run.
  if (lanes.length === 0) return null;
  const runs: BenchmarkRun[] = [];
  for (const entry of raw.runs) {
    const run = coerceRun(entry);
    if (run !== null) runs.push(run);
  }
  return {
    id: raw.id,
    name: raw.name,
    prompts,
    lanes: lanes.slice(0, MAX_LANES),
    runs: runs.slice(0, RUN_CAP),
  };
}

/** Load persisted benchmarks; corrupt or missing data starts empty. */
export function loadBenchmarks(): Benchmark[] {
  try {
    const raw = window.localStorage.getItem(BENCHMARK_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const benchmarks: Benchmark[] = [];
    for (const entry of parsed) {
      const benchmark = coerceBenchmark(entry);
      if (benchmark !== null) benchmarks.push(benchmark);
    }
    return benchmarks;
  } catch {
    return [];
  }
}

export function saveBenchmarks(benchmarks: Benchmark[]): void {
  try {
    window.localStorage.setItem(BENCHMARK_STORAGE_KEY, JSON.stringify(benchmarks));
  } catch {
    // Quota/private-mode failures: benchmarks simply won't survive a
    // restart. It must never take the run it was recording down with it.
  }
}

/* ------------------------------------------------------------- migration */

/**
 * The id a given legacy bench migrates to.
 *
 * Derived from the old id rather than generated, which is what makes the
 * migration idempotent: run it a second time and every candidate is already
 * present, so nothing is added. The legacy key is deliberately *not*
 * deleted (R7), so "have I already done this?" cannot be answered by its
 * absence — it has to be answered by what is already in the list.
 */
export function migratedBenchmarkId(benchId: string): string {
  return `bm-from-${benchId}`;
}

function migratedLaneId(benchId: string): string {
  return `ln-from-${benchId}`;
}

/**
 * Convert one R4 bench. Its single model becomes the one lane, its prompts
 * come across untouched, and each old run becomes a single-lane run whose
 * `results[]` are `cells[]` carrying that lane's id.
 *
 * Two things about the old shape have nowhere to land, both stated here
 * rather than left to be discovered:
 *
 * - `modelfile` is null, per R7. The old `snapshotId` named a T1 Modelfile
 *   *snapshot*, not a variant tag, so putting it in the lane chip would
 *   print an opaque id where a name belongs.
 * - R4 kept 8 runs and R7 keeps 6, so a bench at the old cap loses its two
 *   oldest. They were already the next to be evicted.
 */
function benchmarkFromBench(raw: Record<string, unknown>): Benchmark | null {
  if (
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.model !== "string" ||
    !Array.isArray(raw.prompts) ||
    !Array.isArray(raw.runs)
  ) {
    return null;
  }
  const prompts: BenchmarkPrompt[] = [];
  for (const entry of raw.prompts) {
    const prompt = coercePrompt(entry);
    if (prompt === null) return null;
    prompts.push(prompt);
  }
  const laneId = migratedLaneId(raw.id);
  const runs: BenchmarkRun[] = [];
  for (const entry of raw.runs) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const old = entry as Record<string, unknown>;
    if (typeof old.id !== "string" || typeof old.ranAt !== "string") continue;
    if (typeof old.seed !== "number" || !Number.isFinite(old.seed)) continue;
    if (!Array.isArray(old.results)) continue;
    const cells: Cell[] = [];
    for (const result of old.results) {
      // A legacy result is a cell with a laneId bolted on; everything else
      // about it — content, thinking, stats, error — is already the R7
      // shape, so the same coercion reads it.
      if (typeof result !== "object" || result === null || Array.isArray(result)) continue;
      const cell = coerceCell({ ...(result as Record<string, unknown>), laneId });
      if (cell !== null) cells.push(cell);
    }
    runs.push({
      id: old.id,
      ranAt: old.ranAt,
      seed: old.seed,
      partial: old.partial !== false,
      cells,
    });
  }
  return {
    id: migratedBenchmarkId(raw.id),
    name: raw.name,
    prompts,
    lanes: [{ id: laneId, model: raw.model, modelfile: null }],
    runs: runs.slice(0, RUN_CAP),
  };
}

/**
 * Fold R4's benches into the benchmark list (R7).
 *
 * Reads `remuda.benches.v1` and leaves it in place — a downgrade still
 * finds its data. Returns the *same reference* when there is nothing to
 * migrate, so the caller can use identity to decide whether to save.
 *
 * Idempotent by construction: a migrated benchmark's id is a function of
 * the bench it came from, so a second pass finds it already present and
 * adds nothing. Edits made to a migrated benchmark are therefore safe — the
 * migration will never overwrite or duplicate them.
 */
export function migrateBenches(benchmarks: Benchmark[]): Benchmark[] {
  let legacy: unknown;
  try {
    const raw = window.localStorage.getItem(LEGACY_BENCH_STORAGE_KEY);
    if (raw === null) return benchmarks;
    legacy = JSON.parse(raw);
  } catch {
    return benchmarks;
  }
  if (!Array.isArray(legacy)) return benchmarks;
  const known = new Set(benchmarks.map((b) => b.id));
  const added: Benchmark[] = [];
  for (const entry of legacy) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const converted = benchmarkFromBench(entry as Record<string, unknown>);
    if (converted === null) continue;
    if (known.has(converted.id)) continue;
    known.add(converted.id);
    added.push(converted);
  }
  if (added.length === 0) return benchmarks;
  return [...benchmarks, ...added];
}

/* ---------------------------------------------------------------- labels */

/** "gemma-4-31b · terse-v2" — the header's lane chip. */
export function laneLabel(lane: Lane): string {
  const model = lane.model.replace(/:latest$/, "");
  return lane.modelfile === null ? `${model} · Original` : `${model} · ${lane.modelfile}`;
}

/** "6 prompts · 2 lanes · 3 runs" — the rail's second line. */
export function benchmarkSubtitle(benchmark: Benchmark): string {
  const lanes =
    benchmark.lanes.length === 1 ? "1 lane" : `${benchmark.lanes.length} lanes`;
  if (benchmark.prompts.length === 0) return `no prompts yet · ${lanes}`;
  const prompts =
    benchmark.prompts.length === 1 ? "1 prompt" : `${benchmark.prompts.length} prompts`;
  if (benchmark.runs.length === 0) return `${prompts} · ${lanes} · never run`;
  const runs = benchmark.runs.length === 1 ? "1 run" : `${benchmark.runs.length} runs`;
  return `${prompts} · ${lanes} · ${runs}`;
}

/** "run 7" — runs are numbered oldest-to-newest within what is kept. */
export function runLabel(benchmark: Benchmark, runId: string): string {
  const index = benchmark.runs.findIndex((r) => r.id === runId);
  if (index === -1) return "run";
  return `run ${benchmark.runs.length - index}`;
}
