/**
 * Tag identity (SPEC.md §6). Pure — no I/O, no React.
 *
 * Ollama does not report one canonical spelling of a tag. `/api/tags` and
 * `/api/ps` can disagree about the implicit `:latest` suffix and about case,
 * which is why `client.ts` has always compared them normalised rather than
 * literally. Anything matching a model against the *running* set has the same
 * problem, so the rule lives here instead of being re-derived per call site:
 * comparing raw strings silently mistakes a resident model for an absent one.
 *
 * This normalises only for **comparison**. The literal tag stays what goes on
 * the wire and what is shown on screen — SPEC §5.1 keeps every row's exact
 * tag visible, and lower-casing it for display would be a different lie.
 */

/** The comparison form of a tag: lower-cased, with an implicit `:latest` dropped. */
export function normalizeTag(tag: string): string {
  const lower = tag.trim().toLowerCase();
  return lower.endsWith(":latest") ? lower.slice(0, -":latest".length) : lower;
}

/** True when two tags name the same model, however each was spelled. */
export function sameTag(a: string, b: string): boolean {
  return normalizeTag(a) === normalizeTag(b);
}
