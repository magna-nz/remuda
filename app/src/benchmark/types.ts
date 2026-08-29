/**
 * The Benchmark data model (docs/SPEC-round-two.md R7).
 *
 * A benchmark compares **several configurations against each other** over one
 * set of prompts. That is the axis R4's bench got wrong: it compared a single
 * configuration against its own past, which is the narrower question and the
 * one A/B Compare (SPEC-tuning T2) already answers better for a single
 * prompt. A benchmark is Compare generalised to a prompt set, so the old
 * feature survives inside it as a benchmark with one lane.
 *
 * This file is types only, so the run loop and the views can be built against
 * the same shapes without either waiting on the other.
 */

/** One configuration under test. */
export interface Lane {
  id: string;
  /**
   * The tag actually loaded and sent to. For a variant this is the variant's
   * own tag, because that is what Ollama runs.
   */
  model: string;
  /**
   * The variant this lane represents, or null for the base model. Display
   * only — `model` is what goes on the wire, exactly as T2's LaneConfig does
   * it.
   */
  modelfile: string | null;
}

/** One prompt, replayed against every lane. */
export interface BenchmarkPrompt {
  id: string;
  text: string;
}

/**
 * One lane's answer to one prompt.
 *
 * `error` and `content` are not exclusive: a stream that failed part-way has
 * both, and throwing the partial text away would hide what the model managed
 * before it stopped.
 */
export interface Cell {
  promptId: string;
  laneId: string;
  content: string;
  thinking?: string;
  stats?: CellStats;
  /** SPEC §9: the server's text, verbatim. A failed cell is still a result. */
  error?: string;
}

export interface CellStats {
  /**
   * null when the server reported no count. Absent, never zero: "0 tok"
   * beside a full answer is a measurement the reader will act on, and no
   * measurement was ever taken (SPEC §8).
   */
  evalCount: number | null;
  /** null when the server reported no usable duration. */
  tokPerSec: number | null;
  ms: number;
}

export interface BenchmarkRun {
  id: string;
  ranAt: string; // ISO 8601
  /**
   * Pinned across every lane *and* every prompt of this run. Two lanes on two
   * seeds measure sampling noise, which is the one thing a benchmark must
   * not do.
   */
  seed: number;
  /** Cancelled before every cell was filled. Finished cells are kept. */
  partial: boolean;
  cells: Cell[];
}

export interface Benchmark {
  id: string;
  name: string;
  prompts: BenchmarkPrompt[];
  /** 1..MAX_LANES configurations, in the order they are shown and run. */
  lanes: Lane[];
  /** Newest first; capped at RUN_CAP. */
  runs: BenchmarkRun[];
}

/** Do not bump without a migration: see `migrateBenches` in benchmarks.ts. */
export const BENCHMARK_STORAGE_KEY = "remuda.benchmarks.v1";

/** The key R4 wrote. Read once for migration, never written again. */
export const LEGACY_BENCH_STORAGE_KEY = "remuda.benches.v1";

/**
 * Runs are the bulk of the payload — every lane's full answer to every
 * prompt — so the cap is lower than R4's 8.
 */
export const RUN_CAP = 6;

/**
 * More than four lanes is a full model load each, and a table nobody can
 * read side by side.
 */
export const MAX_LANES = 4;

/** Answers are trimmed to this before storage, as R4's prose cap did. */
export const PROSE_CAP = 4000;
