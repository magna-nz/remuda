/**
 * Word-level diff for two bench answers (docs/SPEC-round-two.md R4).
 *
 * There is exactly one diff in Remuda and it lives in editor/diff.ts. This
 * module does not re-implement it — it changes what a "line" means. Words
 * are handed to `diffLines` one per line, and the `oldLine` / `newLine`
 * numbers it returns are used to look each token's original whitespace back
 * up, so the reassembled text keeps its paragraphs instead of collapsing to
 * a single space-joined run.
 *
 * Consequences of that reuse, both deliberate:
 *
 * - The LCS is over whole words, so a one-character typo marks the word
 *   changed rather than the character. For prose that reads better than a
 *   character diff, which shreds.
 * - `diffLines` falls back to "replaced wholesale" past its own 1500-line
 *   ceiling, which here means 1500 words. Answers are stored trimmed
 *   (benches.ts PROSE_CAP), so this is well out of reach in practice, and
 *   when it is reached the output is still correct — just coarse.
 *
 * Pure: no React, no storage, no I/O.
 */
import { diffLines } from "../editor/diff";

export type WordChunkKind = "same" | "add" | "del";

export interface WordChunk {
  kind: WordChunkKind;
  /** Words plus the whitespace that separated them, ready to render. */
  text: string;
}

interface Tokens {
  /** Non-whitespace runs, in order. Never contains a newline. */
  words: string[];
  /** `seps[i]` is the whitespace that followed `words[i]`; "" at the end. */
  seps: string[];
}

function tokenize(text: string): Tokens {
  const words: string[] = [];
  const seps: string[] = [];
  const re = /(\S+)(\s*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    words.push(match[1]!);
    seps.push(match[2]!);
  }
  return { words, seps };
}

/**
 * Old → new, as renderable chunks. Consecutive tokens of the same kind are
 * merged, so a rewritten sentence is one `<del>` and one `<ins>` rather than
 * a word-by-word confetti of them.
 *
 * Whitespace is never itself a change: it rides along with the word before
 * it, taken from whichever side that word came from.
 */
export function diffWords(oldText: string, newText: string): WordChunk[] {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const chunks: WordChunk[] = [];
  for (const line of diffLines(a.words.join("\n"), b.words.join("\n"))) {
    const sep =
      line.kind === "del"
        ? (a.seps[(line.oldLine ?? 0) - 1] ?? " ")
        : (b.seps[(line.newLine ?? 0) - 1] ?? " ");
    const text = line.text + sep;
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.kind === line.kind) last.text += text;
    else chunks.push({ kind: line.kind, text });
  }
  const tail = chunks[chunks.length - 1];
  if (tail !== undefined) tail.text = tail.text.replace(/\s+$/, "");
  return chunks;
}

/** One side of the two-column view: the old text with its deletions marked. */
export function oldSide(chunks: WordChunk[]): WordChunk[] {
  return chunks.filter((c) => c.kind !== "add");
}

/** The other side: the new text with its insertions marked. */
export function newSide(chunks: WordChunk[]): WordChunk[] {
  return chunks.filter((c) => c.kind !== "del");
}

/**
 * Whether two answers differ at all — the `same` / `changed` badge, and
 * nothing more than that. It reports a *textual* difference. It does not
 * report which answer is better, because Remuda does not know and will not
 * guess (SPEC-tuning T5).
 *
 * Leading and trailing whitespace is not a difference; interior whitespace
 * is left alone, because a reply that reflowed its paragraphs did change.
 */
export function sameAnswer(oldText: string, newText: string): boolean {
  return oldText.trim() === newText.trim();
}
