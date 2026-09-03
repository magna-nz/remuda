/**
 * The line diff behind the history view (SPEC-tuning.md T1): LCS output,
 * line numbering on both sides, and the `+4 −1 · SYSTEM, temperature`
 * summary the timeline shows.
 */
import { describe, expect, it } from "vitest";
import {
  diffLines,
  formatSummary,
  splitLines,
  summarize,
  summarizeDiff,
} from "./diff";

describe("splitLines", () => {
  it("treats a trailing newline as a terminator, not a new line", () => {
    expect(splitLines("FROM a\n")).toEqual(["FROM a"]);
    expect(splitLines("FROM a\n\n")).toEqual(["FROM a", ""]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("diffLines", () => {
  it("identical text is all `same`, numbered on both sides", () => {
    const lines = diffLines("a\nb\n", "a\nb\n");
    expect(lines).toEqual([
      { kind: "same", text: "a", oldLine: 1, newLine: 1 },
      { kind: "same", text: "b", oldLine: 2, newLine: 2 },
    ]);
  });

  it("keeps the common lines and marks only the change", () => {
    const before = "FROM llama3.1:8b\nSYSTEM \"\"\"Be helpful.\"\"\"\nPARAMETER top_p 0.9\n";
    const after = "FROM llama3.1:8b\nSYSTEM \"\"\"Be terse.\"\"\"\nPARAMETER top_p 0.9\n";
    const lines = diffLines(before, after);
    expect(lines.map((l) => l.kind)).toEqual(["same", "del", "add", "same"]);
    expect(lines[1]).toEqual({
      kind: "del",
      text: 'SYSTEM """Be helpful."""',
      oldLine: 2,
      newLine: null,
    });
    expect(lines[2]).toEqual({
      kind: "add",
      text: 'SYSTEM """Be terse."""',
      oldLine: null,
      newLine: 2,
    });
    // The trailing line keeps its number on both sides.
    expect(lines[3]).toEqual({
      kind: "same",
      text: "PARAMETER top_p 0.9",
      oldLine: 3,
      newLine: 3,
    });
  });

  it("handles pure insertion and pure deletion", () => {
    expect(diffLines("a\n", "a\nb\n").map((l) => l.kind)).toEqual(["same", "add"]);
    expect(diffLines("a\nb\n", "a\n").map((l) => l.kind)).toEqual(["same", "del"]);
    expect(diffLines("", "a\n")).toEqual([{ kind: "add", text: "a", oldLine: null, newLine: 1 }]);
  });
});

describe("summarizeDiff", () => {
  it("counts additions and removals and names the instructions touched", () => {
    const before = "FROM llama3.1:8b\nSYSTEM \"\"\"Be helpful.\"\"\"\nPARAMETER top_p 0.9\n";
    const after =
      "FROM llama3.1:8b\nSYSTEM \"\"\"Be terse.\nNever apologise.\"\"\"\nPARAMETER temperature 0.4\nPARAMETER top_p 0.9\n";
    const summary = summarize(before, after);
    expect(summary.added).toBe(3);
    expect(summary.removed).toBe(1);
    expect(summary.fields).toEqual(["SYSTEM", "temperature"]);
    expect(formatSummary(summary)).toBe("+3 −1 · SYSTEM, temperature");
  });

  it("attributes a continuation line to the instruction it sits inside", () => {
    const before = 'FROM a\nSYSTEM """one\ntwo"""\n';
    const after = 'FROM a\nSYSTEM """one\nthree"""\n';
    expect(summarize(before, after).fields).toEqual(["SYSTEM"]);
  });

  it("no change reads as no change", () => {
    expect(formatSummary(summarize("a\n", "a\n"))).toBe("no change");
    expect(summarizeDiff(diffLines("a\n", "a\n"))).toEqual({ added: 0, removed: 0, fields: [] });
  });

  it("counts without fields when the change is only blank lines or comments", () => {
    const summary = summarize("FROM a\n", "FROM a\n\n# a note\n");
    expect(formatSummary(summary)).toBe("+2 · FROM");
  });
});
