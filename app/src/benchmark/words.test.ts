/**
 * The word diff (docs/SPEC-round-two.md R7), moved across from R4's bench.
 *
 * Two things are under test: that the diff marks only what moved and
 * reassembles both sides losslessly, and that `sameAnswer` reports a
 * *textual* difference and never a judgement about which answer is better.
 */
import { describe, expect, it } from "vitest";
import { diffWords, newSide, oldSide, sameAnswer } from "./words";

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

describe("sameAnswer", () => {
  it("ignores leading and trailing whitespace, but not interior reflow", () => {
    expect(sameAnswer("  hello world  ", "hello world")).toBe(true);
    expect(sameAnswer("hello world", "hello  world")).toBe(false);
  });

  it("is a diff, not a verdict: length and quality do not enter into it", () => {
    // Whichever way round, two different texts are different — nothing here
    // knows or claims that one of them is better.
    expect(sameAnswer("terse", "a longer, hedged, worse answer")).toBe(false);
    expect(sameAnswer("a longer, hedged, worse answer", "terse")).toBe(false);
  });
});
