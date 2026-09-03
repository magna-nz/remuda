/**
 * A line diff for the Modelfile history view (SPEC-tuning.md T1).
 *
 * Plain LCS over lines — Modelfiles are a couple of hundred lines at the
 * outside, so the quadratic table is free and a dependency would not be.
 * Pure: no React, no storage, no I/O.
 */

export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number on the old side; null for an addition. */
  oldLine: number | null;
  /** 1-based line number on the new side; null for a deletion. */
  newLine: number | null;
}

export interface DiffSummary {
  added: number;
  removed: number;
  /** Modelfile instructions the change touched, first-seen order. */
  fields: string[];
}

/**
 * Above this the LCS table stops being free, and a Modelfile that long is
 * pathological anyway — fall back to "replaced wholesale" rather than hang
 * the editor.
 */
const MAX_LINES = 1500;

/**
 * Split into lines for display. A trailing newline terminates the last line
 * rather than starting an empty one, so `"FROM x\n"` is one line, not two.
 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function wholesale(oldLines: string[], newLines: string[]): DiffLine[] {
  return [
    ...oldLines.map((text, i) => ({ kind: "del" as const, text, oldLine: i + 1, newLine: null })),
    ...newLines.map((text, i) => ({ kind: "add" as const, text, oldLine: null, newLine: i + 1 })),
  ];
}

/**
 * Unified line diff, old → new. Deletions come before the additions that
 * replace them, which is what the diff pane renders.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return wholesale(a, b);

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i]!, oldLine: i + 1, newLine: null });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]!, oldLine: null, newLine: j + 1 });
      j++;
    }
  }
  for (; i < a.length; i++) {
    out.push({ kind: "del", text: a[i]!, oldLine: i + 1, newLine: null });
  }
  for (; j < b.length; j++) {
    out.push({ kind: "add", text: b[j]!, oldLine: null, newLine: j + 1 });
  }
  return out;
}

const PARAMETER_RE = /^\s*PARAMETER\s+(\S+)/i;
const KEYWORD_RE = /^\s*(FROM|SYSTEM|TEMPLATE|ADAPTER|LICENSE|MESSAGE)\b/i;

/**
 * Which instruction a line belongs to, or null when it carries no keyword
 * of its own — a continuation line inside a `"""` block, a comment, a blank.
 */
function fieldOf(line: string): string | null {
  const parameter = PARAMETER_RE.exec(line);
  if (parameter) return parameter[1]!.toLowerCase();
  const keyword = KEYWORD_RE.exec(line);
  if (keyword) return keyword[1]!.toUpperCase();
  return null;
}

/**
 * `+4 −1 · SYSTEM, temperature` — the counts and the instructions touched.
 *
 * Continuation lines inherit the last instruction seen while walking the
 * diff in order, so editing the second line of a `SYSTEM """…"""` block is
 * still reported as SYSTEM rather than as nothing at all.
 */
export function summarizeDiff(lines: DiffLine[]): DiffSummary {
  let added = 0;
  let removed = 0;
  const fields: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    const own = fieldOf(line.text);
    if (own !== null) current = own;
    if (line.kind === "same") continue;
    if (line.kind === "add") added++;
    else removed++;
    const field = own ?? current;
    if (field !== null && !fields.includes(field)) fields.push(field);
  }
  return { added, removed, fields };
}

/** Convenience: diff two texts and summarize in one step. */
export function summarize(oldText: string, newText: string): DiffSummary {
  return summarizeDiff(diffLines(oldText, newText));
}

/** `+4 −1` — the counts alone, as the timeline renders them. */
export function formatCounts(summary: DiffSummary): string {
  const parts: string[] = [];
  if (summary.added > 0) parts.push(`+${summary.added}`);
  if (summary.removed > 0) parts.push(`−${summary.removed}`);
  return parts.join(" ");
}

/** `+4 −1 · SYSTEM, temperature`; "no change" when nothing moved. */
export function formatSummary(summary: DiffSummary): string {
  const counts = formatCounts(summary);
  if (counts === "") return "no change";
  return summary.fields.length > 0 ? `${counts} · ${summary.fields.join(", ")}` : counts;
}
