/**
 * The benchmark table's rows and its tally strip (docs/SPEC-round-two.md
 * R7). Pure: no React, no storage, no I/O.
 *
 * The rule this file exists to hold: **different is a diff, never a
 * verdict.** Every state below comes from comparing two strings and from
 * whether the request failed. Nothing here ranks a lane, nothing sorts by
 * quality, and nothing may ever be added that does — an LLM judge would
 * make Remuda a different and much less trustworthy product.
 *
 * Two consequences that look like omissions and are not:
 *
 * - Rows stay in **prompt order**. R4 floated changed rows to the top
 *   because it had one column and you only wanted to read what moved. A
 *   benchmark is read across, lane against lane, so reordering would only
 *   make "row 4" mean something different every run.
 * - The comparison is always **against lane 1**, never lane against lane in
 *   both directions. With two lanes that is B against A; with more, each
 *   lane past the first against the first. Lane 1 is the baseline because
 *   it is first, not because it is best — reorder the lanes and the
 *   baseline moves with them.
 */
import type { Benchmark, BenchmarkPrompt, BenchmarkRun, Cell, Lane } from "./types";
import { sameAnswer } from "./words";

/**
 * What one cell says, relative to lane 1's answer to the same prompt.
 *
 * - `baseline`  — this is lane 1. Nothing is compared against itself.
 * - `same`      — textually identical to lane 1's answer.
 * - `different` — it is not. That is all it means.
 * - `error`     — the request (or the lane's model load) failed. A real
 *                 result, kept with its cause.
 * - `pending`   — no cell: the run was cancelled before reaching it, or
 *                 this lane was added after the run.
 */
export type CellState = "baseline" | "same" | "different" | "error" | "pending";

export interface RowCell {
  lane: Lane;
  cell: Cell | null;
  state: CellState;
}

/**
 * What a row says about one prompt.
 *
 * - `different` — at least one lane past the first differs from lane 1.
 * - `same`      — every lane answered and they all agree.
 * - `error`     — at least one lane failed. Outranks the rest: there is no
 *                 honest diff to report next to a missing answer.
 * - `pending`   — at least one lane has no cell, and none errored.
 * - `single`    — one lane, so there is nothing to compare. Calling that
 *                 "same" would claim an agreement that was never tested.
 */
export type RowState = "different" | "same" | "error" | "pending" | "single";

export interface BenchmarkRow {
  prompt: BenchmarkPrompt;
  /** 1-based position in the benchmark, and in the table — they are equal. */
  number: number;
  state: RowState;
  /** One per lane, in lane order. Lane 1 first, always. */
  cells: RowCell[];
  /**
   * The ids of the lanes whose answer differs from lane 1's. Empty when
   * they agree, when there is only one lane, or when there is nothing to
   * compare yet.
   */
  differing: string[];
}

export interface BenchmarkTally {
  different: number;
  same: number;
  error: number;
  pending: number;
  single: number;
}

function cellFor(run: BenchmarkRun | null, promptId: string, laneId: string): Cell | null {
  if (run === null) return null;
  return run.cells.find((c) => c.promptId === promptId && c.laneId === laneId) ?? null;
}

/**
 * One cell's state against the baseline cell.
 *
 * Order of decisions matters. A failure outranks everything, because there
 * is no answer to diff. A baseline that is missing or errored leaves the
 * other lanes with nothing to compare against, so they read as `pending`
 * rather than being called `different` from an absence.
 *
 * This never returns `baseline`: lane 1 is identified by its position, not
 * by a comparison, and `buildRows` labels it there.
 */
export function cellState(cell: Cell | null, baseline: Cell | null): CellState {
  if (cell === null) return "pending";
  if (cell.error !== undefined) return "error";
  if (baseline === null || baseline.error !== undefined) return "pending";
  return sameAnswer(baseline.content, cell.content) ? "same" : "different";
}

/** One row per prompt, one cell per lane, in prompt order and lane order. */
export function buildRows(benchmark: Benchmark, run: BenchmarkRun | null): BenchmarkRow[] {
  return benchmark.prompts.map((prompt, index): BenchmarkRow => {
    const first = benchmark.lanes[0];
    const baseline = first === undefined ? null : cellFor(run, prompt.id, first.id);
    const cells = benchmark.lanes.map((lane, laneIndex): RowCell => {
      const cell = cellFor(run, prompt.id, lane.id);
      if (laneIndex === 0) {
        // The baseline is still allowed to be an error or a gap; it just
        // is not compared with anything.
        if (cell === null) return { lane, cell, state: "pending" };
        if (cell.error !== undefined) return { lane, cell, state: "error" };
        return { lane, cell, state: "baseline" };
      }
      return { lane, cell, state: cellState(cell, baseline) };
    });
    return {
      prompt,
      number: index + 1,
      state: rowState(cells),
      cells,
      differing: cells.filter((c) => c.state === "different").map((c) => c.lane.id),
    };
  });
}

/**
 * The row's own state, from its cells. Never from their content: this
 * function cannot tell you which lane won, and there is no version of it
 * that should.
 */
export function rowState(cells: RowCell[]): RowState {
  if (cells.length <= 1) {
    const only = cells[0];
    if (only === undefined || only.state === "pending") return "pending";
    if (only.state === "error") return "error";
    return "single";
  }
  if (cells.some((c) => c.state === "error")) return "error";
  if (cells.some((c) => c.state === "pending")) return "pending";
  return cells.some((c) => c.state === "different") ? "different" : "same";
}

export function tally(rows: BenchmarkRow[]): BenchmarkTally {
  const counts: BenchmarkTally = { different: 0, same: 0, error: 0, pending: 0, single: 0 };
  for (const row of rows) counts[row.state] += 1;
  return counts;
}

/** "2 different · 3 same · 1 error", skipping every zero. */
export function tallyParts(counts: BenchmarkTally): { key: RowState; label: string }[] {
  const parts: { key: RowState; label: string }[] = [];
  if (counts.different > 0) parts.push({ key: "different", label: `${counts.different} different` });
  if (counts.same > 0) parts.push({ key: "same", label: `${counts.same} same` });
  if (counts.error > 0) {
    parts.push({
      key: "error",
      label: `${counts.error} ${counts.error === 1 ? "error" : "errors"}`,
    });
  }
  if (counts.pending > 0) parts.push({ key: "pending", label: `${counts.pending} not run` });
  // Deliberately not "n same": one lane agreed with nobody, it just answered.
  if (counts.single > 0) parts.push({ key: "single", label: `${counts.single} answered` });
  return parts;
}

export const ROW_BADGE: Record<RowState, string> = {
  different: "Different",
  same: "Same",
  error: "Error",
  pending: "Not run",
  single: "Answered",
};

export const CELL_BADGE: Record<CellState, string> = {
  baseline: "Lane 1",
  same: "Same",
  different: "Different",
  error: "Error",
  pending: "Not run",
};

/** "2.4 s" for a finished cell, "—" for one with no timing to show. */
export function formatDuration(cell: Cell | null): string {
  if (cell === null || cell.error !== undefined || cell.stats === undefined) return "—";
  const seconds = cell.stats.ms / 1000;
  return seconds >= 10 ? `${Math.round(seconds)} s` : `${seconds.toFixed(1)} s`;
}

/** The collapsed cell's one-line preview: the answer, or the failure. */
export function cellSnippet(cell: Cell | null): string {
  if (cell === null) return "not run";
  if (cell.error !== undefined) return cell.error;
  const text = cell.content.trim().replace(/\s+/g, " ");
  return text === "" ? "(empty answer)" : text;
}
