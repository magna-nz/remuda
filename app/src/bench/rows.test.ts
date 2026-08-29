/**
 * The run table's rows and the word diff underneath them (T5 / R4).
 *
 * The rule under test throughout: same/changed is a *diff*. Nothing here
 * ranks an answer, and the sort is a partition on "did the text move", not
 * on quality.
 */
import { describe, expect, it } from "vitest";
import { addPrompt, createBench, type Bench, type BenchResult, type BenchRun } from "./benches";
import { ROW_BADGE, buildRows, formatDuration, rowSnippet, rowState, tally, tallyParts } from "./rows";
import { diffWords, newSide, oldSide, sameAnswer } from "./words";

function benchOf(...texts: string[]): Bench {
  return texts.reduce((b, text) => addPrompt(b, text), createBench("b", "m:latest"));
}

function runOf(bench: Bench, results: (Partial<BenchResult> | null)[]): BenchRun {
  const list: BenchResult[] = [];
  results.forEach((r, i) => {
    if (r === null) return;
    list.push({ promptId: bench.prompts[i]!.id, content: "", ...r });
  });
  return { id: "r", ranAt: "t", snapshotId: null, seed: 1, partial: false, results: list };
}

describe("rowState", () => {
  const ok = (content: string): BenchResult => ({ promptId: "p", content });

  it("is a diff, not a verdict", () => {
    expect(rowState(ok("same text"), ok("same text"))).toBe("same");
    expect(rowState(ok("a longer, worse answer"), ok("terse"))).toBe("changed");
    // Longer/shorter, better/worse: the state is the same either way.
    expect(rowState(ok("terse"), ok("a longer, worse answer"))).toBe("changed");
  });

  it("calls a failure an error, and never lets it look like an answer", () => {
    expect(rowState({ promptId: "p", content: "", error: "boom" }, ok("x"))).toBe("error");
  });

  it("calls a first sighting new, not changed", () => {
    expect(rowState(ok("hello"), null)).toBe("new");
  });

  it("calls a recovery from an error changed — that is what a bench is for", () => {
    const previous: BenchResult = { promptId: "p", content: "", error: "context length exceeded" };
    expect(rowState(ok("an answer at last"), previous)).toBe("changed");
  });

  it("calls a prompt the run never reached pending", () => {
    expect(rowState(null, ok("x"))).toBe("pending");
  });

  it("ignores leading and trailing whitespace, but not interior reflow", () => {
    expect(sameAnswer("  hello world  ", "hello world")).toBe(true);
    expect(sameAnswer("hello world", "hello  world")).toBe(false);
  });
});

describe("buildRows", () => {
  const bench = benchOf("one", "two", "three", "four");

  it("puts changed rows first and leaves the rest in prompt order", () => {
    const previous = runOf(bench, [{ content: "a" }, { content: "b" }, { content: "c" }, { content: "d" }]);
    const current = runOf(bench, [
      { content: "a" },
      { content: "B!" },
      { content: "c" },
      { content: "D!" },
    ]);
    const rows = buildRows(bench, current, previous);
    expect(rows.map((r) => r.prompt.text)).toEqual(["two", "four", "one", "three"]);
    // The number stays with the prompt, so "row 4" means the same prompt
    // between runs even though the table reordered.
    expect(rows.map((r) => r.number)).toEqual([2, 4, 1, 3]);
  });

  it("a bench that has never run is all rows, all pending", () => {
    const rows = buildRows(bench, null, null);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.state))).toEqual(new Set(["pending"]));
    expect(tally(rows).pending).toBe(4);
  });

  it("a cancelled run keeps its finished rows and shows the rest as not run", () => {
    const previous = runOf(bench, [{ content: "a" }, { content: "b" }, { content: "c" }, { content: "d" }]);
    const partial = runOf(bench, [{ content: "a" }, { content: "B!" }, null, null]);
    const rows = buildRows(bench, partial, previous);
    expect(tally(rows)).toEqual({ changed: 1, same: 1, error: 0, new: 0, pending: 2 });
  });
});

describe("the tally strip", () => {
  it("skips every zero and pluralises errors", () => {
    expect(tallyParts({ changed: 2, same: 3, error: 1, new: 0, pending: 0 }).map((p) => p.label))
      .toEqual(["2 changed", "3 same", "1 error"]);
    expect(tallyParts({ changed: 0, same: 0, error: 2, new: 1, pending: 4 }).map((p) => p.label))
      .toEqual(["2 errors", "1 new", "4 not run"]);
  });

  it("badges by state and never by quality", () => {
    expect(ROW_BADGE).toEqual({
      changed: "Changed",
      same: "Same",
      error: "Error",
      new: "New",
      pending: "Not run",
    });
  });
});

describe("row presentation", () => {
  const bench = benchOf("one");

  it("shows an em dash where there is no timing to show", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration({ promptId: "p", content: "", error: "boom" })).toBe("—");
    expect(formatDuration({ promptId: "p", content: "x" })).toBe("—");
    expect(formatDuration({ promptId: "p", content: "x", stats: { evalCount: 1, tokPerSec: 1, ms: 2400 } }))
      .toBe("2.4 s");
    expect(formatDuration({ promptId: "p", content: "x", stats: { evalCount: 1, tokPerSec: 1, ms: 41200 } }))
      .toBe("41 s");
  });

  it("previews the failure, not a blank, on an errored row", () => {
    const rows = buildRows(bench, runOf(bench, [{ content: "", error: "context length exceeded" }]), null);
    expect(rowSnippet(rows[0]!)).toBe("context length exceeded");
  });

  it("flattens the answer to one line for the collapsed preview", () => {
    const rows = buildRows(bench, runOf(bench, [{ content: "  first line\n\nsecond  line " }]), null);
    expect(rowSnippet(rows[0]!)).toBe("first line second line");
  });
});

describe("diffWords", () => {
  it("marks only the words that moved", () => {
    const chunks = diffWords("the quick brown fox", "the quick red fox");
    expect(chunks.map((c) => c.kind)).toEqual(["same", "del", "add", "same"]);
    expect(chunks.find((c) => c.kind === "del")!.text.trim()).toBe("brown");
    expect(chunks.find((c) => c.kind === "add")!.text.trim()).toBe("red");
  });

  it("merges a rewritten run into one del and one ins, not word confetti", () => {
    const chunks = diffWords("keep this alpha beta gamma end", "keep this one two three end");
    expect(chunks.map((c) => c.kind)).toEqual(["same", "del", "add", "same"]);
    expect(chunks[1]!.text.trim()).toBe("alpha beta gamma");
    expect(chunks[2]!.text.trim()).toBe("one two three");
  });

  it("keeps paragraphs — whitespace rides with the word, and is never itself a change", () => {
    const chunks = diffWords("alpha\n\nbeta gamma", "alpha\n\nbeta delta");
    // Reassembling the unchanged side reproduces the original spacing.
    expect(oldSide(chunks).map((c) => c.text).join("")).toBe("alpha\n\nbeta gamma");
    expect(newSide(chunks).map((c) => c.text).join("")).toBe("alpha\n\nbeta delta");
  });

  it("reassembles both sides losslessly for a wholesale rewrite", () => {
    const before = "one two three";
    const after = "four five";
    const chunks = diffWords(before, after);
    expect(oldSide(chunks).map((c) => c.text).join("")).toBe(before);
    expect(newSide(chunks).map((c) => c.text).join("")).toBe(after);
  });

  it("handles the empty sides without throwing", () => {
    expect(diffWords("", "")).toEqual([]);
    expect(diffWords("", "hello").map((c) => c.kind)).toEqual(["add"]);
    expect(diffWords("hello", "").map((c) => c.kind)).toEqual(["del"]);
  });

  it("survives an answer past the underlying diff's ceiling", () => {
    // editor/diff.ts falls back to "replaced wholesale" past 1500 lines,
    // which here means 1500 words. Coarse, but still correct and still not
    // a throw.
    const long = Array.from({ length: 1600 }, (_, i) => `w${i}`).join(" ");
    const chunks = diffWords(long, `${long} tail`);
    expect(chunks.map((c) => c.kind)).toEqual(["del", "add"]);
    expect(oldSide(chunks).map((c) => c.text).join("")).toBe(long);
    expect(newSide(chunks).map((c) => c.text).join("")).toBe(`${long} tail`);
  });
});
