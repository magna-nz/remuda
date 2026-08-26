/**
 * A display-only scan of the raw Modelfile text for content the friendly
 * form doesn't model — comments, LICENSE/ADAPTER/MESSAGE, advanced TEMPLATE,
 * and any PARAMETER key besides the five the form has controls for
 * (SPEC.md §5.4: "surfaces as an 'advanced' note").
 *
 * This never removes or rewrites anything — the raw text (and the parsed
 * `ModelfileDoc` behind it) stays the single source of truth; this just
 * tells the user something's there that the form can't show them.
 */
const MANAGED_PARAMETER_KEYS = new Set(["temperature", "top_p", "num_ctx", "stop"]);
const MANAGED_KEYWORDS = new Set(["FROM", "SYSTEM"]);

/** Returns a human-readable list of the passthrough kinds found, e.g. ["comments", "LICENSE"]. */
export function passthroughKinds(rawText: string): string[] {
  const kinds = new Set<string>();
  let inBlock = false;

  for (const rawLine of rawText.split("\n")) {
    const line = rawLine.trim();

    if (inBlock) {
      if (countTripleQuotes(line) % 2 === 1) inBlock = false;
      continue;
    }
    if (line === "") continue;
    if (line.startsWith("#")) {
      kinds.add("comments");
      continue;
    }

    const [kwRaw, ...rest] = line.split(/\s+/);
    const kw = (kwRaw ?? "").toUpperCase();
    const restText = rest.join(" ");
    const opensBlock = countTripleQuotes(restText) % 2 === 1;

    if (kw === "PARAMETER") {
      const key = (rest[0] ?? "").toLowerCase();
      if (!MANAGED_PARAMETER_KEYS.has(key)) {
        kinds.add(`PARAMETER ${key || "?"}`);
      }
      if (opensBlock) inBlock = true;
      continue;
    }
    if (MANAGED_KEYWORDS.has(kw)) {
      if (opensBlock) inBlock = true;
      continue;
    }
    // LICENSE, ADAPTER, MESSAGE, TEMPLATE, or anything else unrecognized.
    if (kw !== "") kinds.add(kw);
    if (opensBlock) inBlock = true;
  }

  return Array.from(kinds);
}

function countTripleQuotes(text: string): number {
  return (text.match(/"""/g) ?? []).length;
}
