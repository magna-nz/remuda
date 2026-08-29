/**
 * The run table's rows and its tally strip (docs/SPEC-tuning.md T5,
 * docs/SPEC-round-two.md R4). Pure: no React, no storage, no I/O.
 *
 * The one rule this file exists to hold: **same / changed is a diff, not a
 * verdict.** Every state below is derived from comparing two strings and
 * from whether the request failed. Nothing here ranks an answer, nothing
 * sorts by quality, and nothing may ever be added that does — an LLM judge
 * would make Remuda a different and much less trustworthy product.
 */
import type { Bench, BenchResult, BenchRun } from "./benches";
import { sameAnswer } from "./words";

/**
 * What a row says about one prompt.
 *
 * - `changed` — this run's answer differs from the previous run's.
 * - `same`    — it does not.
 * - `error`   — the request failed. A real result, kept with its cause.
 * - `new`     — there is no previous answer to compare against.
 * - `pending` — the run was cancelled before reaching this prompt.
 */
export type RowState = "changed" | "same" | "error" | "new" | "pending";

export interface BenchRow {
  prompt: { id: string; text: string };
  /**
   * 1-based position in the bench, NOT in the sorted table. It stays with
   * the prompt when changed-first reorders the rows, so "row 5" means the
   * same prompt between runs.
   */
  number: number;
  state: RowState;
  current: BenchResult | null;
  previous: BenchResult | null;
}

export interface BenchTally {
  changed: number;
  same: number;
  error: number;
  new: number;
  pending: number;
}

function resultFor(run: BenchRun | null, promptId: string): BenchResult | null {
  if (run === null) return null;
  return run.results.find((r) => r.promptId === promptId) ?? null;
}

/**
 * Order of decisions matters and is not arbitrary.
 *
 * A failure outranks everything: there is no answer to diff. A previous run
 * that *errored* and a current one that did not is `changed` — going from a
 * context-length failure to a reply is exactly the change a bench is run to
 * find, and calling it `new` would hide it. Only the genuine absence of a
 * previous result is `new`.
 */
export function rowState(current: BenchResult | null, previous: BenchResult | null): RowState {
  if (current === null) return "pending";
  if (current.error !== undefined) return "error";
  if (previous === null) return "new";
  if (previous.error !== undefined) return "changed";
  return sameAnswer(previous.content, current.content) ? "same" : "changed";
}

/**
 * One row per prompt, sorted **changed first** and otherwise in prompt order
 * (R4). The point of a bench is that you read only the rows that moved, so
 * they go to the top; everything else keeps its stable position rather than
 * being ranked, which would be a scoreboard.
 */
export function buildRows(
  bench: Bench,
  run: BenchRun | null,
  previous: BenchRun | null,
): BenchRow[] {
  const rows = bench.prompts.map((prompt, index): BenchRow => {
    const current = resultFor(run, prompt.id);
    const before = resultFor(previous, prompt.id);
    return {
      prompt,
      number: index + 1,
      state: rowState(current, before),
      current,
      previous: before,
    };
  });
  // Stable partition, not a sort key: `changed` to the front, everything
  // else untouched in prompt order.
  return [...rows.filter((r) => r.state === "changed"), ...rows.filter((r) => r.state !== "changed")];
}

export function tally(rows: BenchRow[]): BenchTally {
  const counts: BenchTally = { changed: 0, same: 0, error: 0, new: 0, pending: 0 };
  for (const row of rows) counts[row.state] += 1;
  return counts;
}

/** "2 changed · 3 same · 1 error", skipping every zero. */
export function tallyParts(counts: BenchTally): { key: RowState; label: string }[] {
  const parts: { key: RowState; label: string }[] = [];
  if (counts.changed > 0) parts.push({ key: "changed", label: `${counts.changed} changed` });
  if (counts.same > 0) parts.push({ key: "same", label: `${counts.same} same` });
  if (counts.error > 0) {
    parts.push({ key: "error", label: `${counts.error} ${counts.error === 1 ? "error" : "errors"}` });
  }
  if (counts.new > 0) parts.push({ key: "new", label: `${counts.new} new` });
  if (counts.pending > 0) parts.push({ key: "pending", label: `${counts.pending} not run` });
  return parts;
}

export const ROW_BADGE: Record<RowState, string> = {
  changed: "Changed",
  same: "Same",
  error: "Error",
  new: "New",
  pending: "Not run",
};

/** "2.4 s" for a finished row, "—" for one that has no timing to show. */
export function formatDuration(result: BenchResult | null): string {
  if (result === null || result.error !== undefined || result.stats === undefined) return "—";
  const seconds = result.stats.ms / 1000;
  return seconds >= 10 ? `${Math.round(seconds)} s` : `${seconds.toFixed(1)} s`;
}

/** The collapsed row's one-line preview: the answer, or the failure. */
export function rowSnippet(row: BenchRow): string {
  if (row.current === null) return "not run";
  if (row.current.error !== undefined) return row.current.error;
  const text = row.current.content.trim().replace(/\s+/g, " ");
  return text === "" ? "(empty answer)" : text;
}
