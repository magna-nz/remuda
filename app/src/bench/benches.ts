/**
 * Bench — the data model and its persistence (docs/SPEC-tuning.md T5,
 * docs/SPEC-round-two.md R4).
 *
 * A bench is a saved set of prompts replayed against one model. Each replay
 * is a `BenchRun`; the run table diffs the newest against the one before it.
 *
 * Persistence follows editor/history.ts and chat/sessions.ts exactly — a
 * versioned key, pure load/save, two-tier coercion (a corrupt spine drops
 * the record, a corrupt optional field drops itself), and a try/catch that
 * degrades to an empty list rather than crashing. Answers are the bulk of
 * the payload, so the run cap is low and prose is stored trimmed.
 *
 * Nothing here scores an answer. `same` and `changed` are the output of a
 * text diff and never a verdict — see rows.ts.
 */

/**
 * Do not bump this. Every field added after v1 must be optional, so a v1
 * payload parses unchanged; a new key would orphan — i.e. delete — every
 * existing user's benches for no gain.
 */
export const BENCH_STORAGE_KEY = "remuda.benches.v1";

/** Runs kept per bench (SPEC-tuning T5). Oldest evicted. */
export const RUN_CAP = 8;

/**
 * Longest answer kept per result. T5: "prose is stored trimmed". Eight runs
 * of a dozen prompts at 4 KB each is ~400 KB, an order under localStorage's
 * ~5 MB — and a truncated tail still diffs honestly against another
 * truncated tail, because both were cut at the same place.
 */
export const PROSE_CAP = 4000;

export interface BenchPrompt {
  id: string;
  text: string;
}

/** What the server reported about one answer. Absent on an errored row. */
export interface BenchStats {
  /** Tokens generated. 0 when the server reported no timings at all. */
  evalCount: number;
  /** Generation rate; null when the server reported nothing usable. */
  tokPerSec: number | null;
  /** Wall time for this prompt, as the runner measured it. */
  ms: number;
}

/**
 * One prompt's outcome in one run.
 *
 * `error` is a *real result*, not an absence: a context-length failure is
 * exactly the kind of thing a bench exists to surface, so it is stored,
 * shown with its cause, and never allowed to abort the rest of the run
 * (R4). A prompt that was never reached — the run was cancelled first —
 * has no result at all, which is a different thing.
 */
export interface BenchResult {
  promptId: string;
  content: string;
  thinking?: string;
  stats?: BenchStats;
  /** The failure verbatim (SPEC §9). Present instead of a finished answer. */
  error?: string;
}

export interface BenchRun {
  id: string;
  ranAt: string; // ISO 8601
  /** The T1 Modelfile snapshot this ran against; null when there wasn't one. */
  snapshotId: string | null;
  /**
   * Pinned for the whole run. Two prompts on two seeds measure sampling
   * noise and nothing else — the same reason T2 pins one for a pair.
   */
  seed: number;
  /** Cancelled before every prompt had run. Its finished rows are kept. */
  partial: boolean;
  results: BenchResult[];
}

export interface Bench {
  id: string;
  name: string;
  /** The tag every run of this bench replays against. */
  model: string;
  prompts: BenchPrompt[];
  /** Newest first, capped at RUN_CAP. */
  runs: BenchRun[];
}

export function newBenchId(now: Date = new Date()): string {
  return `bench-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newPromptId(now: Date = new Date()): string {
  return `bp-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newRunId(now: Date = new Date()): string {
  return `br-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Cut stored prose to PROSE_CAP, marking the cut so nothing reads as complete. */
export function trimProse(text: string): string {
  if (text.length <= PROSE_CAP) return text;
  return `${text.slice(0, PROSE_CAP)}…`;
}

export function createBench(name: string, model: string, now: Date = new Date()): Bench {
  return { id: newBenchId(now), name, model, prompts: [], runs: [] };
}

/**
 * The default name for a bench nobody named.
 *
 * Capture must cost nothing (T5: "a bench that costs a form to populate does
 * not get populated"), so the first prompt captured for a model creates the
 * bench outright rather than opening a name dialog. Rename is one click in
 * the header.
 */
export function defaultBenchName(model: string): string {
  return `${model.replace(/:latest$/, "")} bench`;
}

/**
 * Append a prompt. Returns `bench` unchanged — the same reference — when the
 * exact text is already in it, the same content addressing appendSnapshot
 * uses, so pressing "Add to bench" twice on one message does not double the
 * run. Blank text adds nothing.
 */
export function addPrompt(bench: Bench, text: string, now: Date = new Date()): Bench {
  const trimmed = text.trim();
  if (trimmed === "") return bench;
  if (bench.prompts.some((p) => p.text === trimmed)) return bench;
  return { ...bench, prompts: [...bench.prompts, { id: newPromptId(now), text: trimmed }] };
}

export function removePrompt(bench: Bench, promptId: string): Bench {
  if (!bench.prompts.some((p) => p.id === promptId)) return bench;
  return { ...bench, prompts: bench.prompts.filter((p) => p.id !== promptId) };
}

/**
 * Record a run, newest first, evicting the oldest past RUN_CAP.
 *
 * Prose is trimmed on the way in rather than on the way to storage, so what
 * the table renders is what was persisted and a reload cannot change a
 * row's verdict from `same` to `changed`.
 */
export function appendRun(bench: Bench, run: BenchRun): Bench {
  const stored: BenchRun = {
    ...run,
    results: run.results.map((r) => {
      const next: BenchResult = { promptId: r.promptId, content: trimProse(r.content) };
      if (r.thinking !== undefined) next.thinking = trimProse(r.thinking);
      if (r.stats !== undefined) next.stats = r.stats;
      if (r.error !== undefined) next.error = r.error;
      return next;
    }),
  };
  return { ...bench, runs: [stored, ...bench.runs].slice(0, RUN_CAP) };
}

/** The run the table shows by default, and the one it diffs against. */
export function latestRun(bench: Bench): BenchRun | null {
  return bench.runs[0] ?? null;
}

/** The run immediately older than `runId`; null when it is the oldest kept. */
export function previousRun(bench: Bench, runId: string): BenchRun | null {
  const index = bench.runs.findIndex((r) => r.id === runId);
  if (index === -1) return null;
  return bench.runs[index + 1] ?? null;
}

/* ---------------------------------------------------------------- reading */

function coerceStats(value: unknown): BenchStats | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.evalCount !== "number" || !Number.isFinite(raw.evalCount)) return undefined;
  if (typeof raw.ms !== "number" || !Number.isFinite(raw.ms)) return undefined;
  const tokPerSec =
    typeof raw.tokPerSec === "number" && Number.isFinite(raw.tokPerSec) ? raw.tokPerSec : null;
  return { evalCount: raw.evalCount, tokPerSec, ms: raw.ms };
}

/**
 * Optional tier: a result whose spine is intact keeps its place even if the
 * stats block is rubbish. `promptId` and `content` are the spine — without
 * them there is nothing to put in a row.
 */
function coerceResult(value: unknown): BenchResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.promptId !== "string" || typeof raw.content !== "string") return null;
  const result: BenchResult = { promptId: raw.promptId, content: raw.content };
  if (typeof raw.thinking === "string") result.thinking = raw.thinking;
  const stats = coerceStats(raw.stats);
  if (stats !== undefined) result.stats = stats;
  // An error is the whole reason the row is interesting; keep it verbatim.
  if (typeof raw.error === "string" && raw.error !== "") result.error = raw.error;
  return result;
}

/**
 * Spine tier: id / ranAt / seed / results. A run with no readable seed is
 * not a run you can trust the diff of, because the seed is what makes two
 * runs comparable in the first place — so it is dropped, alone, without
 * taking the bench with it.
 */
function coerceRun(value: unknown): BenchRun | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.ranAt !== "string") return null;
  if (typeof raw.seed !== "number" || !Number.isFinite(raw.seed)) return null;
  if (!Array.isArray(raw.results)) return null;
  const results: BenchResult[] = [];
  for (const entry of raw.results) {
    const result = coerceResult(entry);
    if (result !== null) results.push(result);
  }
  return {
    id: raw.id,
    ranAt: raw.ranAt,
    snapshotId: typeof raw.snapshotId === "string" ? raw.snapshotId : null,
    seed: raw.seed,
    // Anything other than an explicit `false` is treated as partial: a run
    // whose flag did not survive should under-claim, not over-claim.
    partial: raw.partial !== false,
    results,
  };
}

function coercePrompt(value: unknown): BenchPrompt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.text !== "string") return null;
  return { id: raw.id, text: raw.text };
}

function coerceBench(value: unknown): Bench | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.model !== "string" ||
    !Array.isArray(raw.prompts) ||
    !Array.isArray(raw.runs)
  ) {
    return null;
  }
  const prompts: BenchPrompt[] = [];
  for (const entry of raw.prompts) {
    const prompt = coercePrompt(entry);
    // A prompt is the spine of the bench: losing one silently would
    // renumber every row and diff answers against the wrong question.
    if (prompt === null) return null;
    prompts.push(prompt);
  }
  const runs: BenchRun[] = [];
  for (const entry of raw.runs) {
    const run = coerceRun(entry);
    if (run !== null) runs.push(run);
  }
  return { id: raw.id, name: raw.name, model: raw.model, prompts, runs: runs.slice(0, RUN_CAP) };
}

/** Load persisted benches; corrupt or missing data starts empty. */
export function loadBenches(): Bench[] {
  try {
    const raw = window.localStorage.getItem(BENCH_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const benches: Bench[] = [];
    for (const entry of parsed) {
      const bench = coerceBench(entry);
      if (bench !== null) benches.push(bench);
    }
    return benches;
  } catch {
    return [];
  }
}

export function saveBenches(benches: Bench[]): void {
  try {
    window.localStorage.setItem(BENCH_STORAGE_KEY, JSON.stringify(benches));
  } catch {
    // Quota/private-mode failures: benches simply won't survive a restart.
    // It must never take the run it was recording down with it.
  }
}

/** "6 prompts · run 7" — the rail's second line. */
export function benchSubtitle(bench: Bench): string {
  const prompts = bench.prompts.length === 1 ? "1 prompt" : `${bench.prompts.length} prompts`;
  if (bench.prompts.length === 0) return "no prompts yet";
  if (bench.runs.length === 0) return `${prompts} · never run`;
  return `${prompts} · ${bench.runs.length === 1 ? "1 run" : `${bench.runs.length} runs`}`;
}

/** "run 7" — runs are numbered oldest-to-newest within what is kept. */
export function runLabel(bench: Bench, runId: string): string {
  const index = bench.runs.findIndex((r) => r.id === runId);
  if (index === -1) return "run";
  return `run ${bench.runs.length - index}`;
}
