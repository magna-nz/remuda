/**
 * The Ollama library catalog (SPEC.md §5.5).
 *
 * Ollama has no registry search API (`/api/search`, `_catalog`, `tags/list`
 * all 404), so the searchable model list can't be fetched live. Instead
 * `scripts/fetch-catalog.mjs` scrapes `https://ollama.com/library` at build
 * time and writes the result to `catalog.json`, which this module imports
 * and types. `parseLibraryIndex` is the pure scraper: it's regex/string
 * based (no DOM) so the same code runs both in the browser-less generator
 * script and in tests against a checked-in fixture. `searchCatalog` is the
 * client-side filter the Pull pane's search box calls against `CATALOG`.
 */
import catalogJson from "./catalog.json";

export interface CatalogModel {
  /** The /library slug, e.g. "qwen3". Pull as-is, or as `${name}:${size}`. */
  name: string;
  description: string;
  /** Parameter-size chips, lowercase, e.g. ["0.6b","1.7b","8b"]. May be empty. */
  sizes: string[];
  /** Capability chips, lowercase, e.g. ["tools","thinking"]. May be empty. */
  capabilities: string[];
  /** Number of published tags. 0 if not found. */
  tagCount: number;
  /** ISO 8601, or null when the page didn't give a parseable date. */
  updated: string | null;
}

export const CATALOG: CatalogModel[] = catalogJson as CatalogModel[];

// A parameter-size chip is not always plain "0.6b"/"235b"/"137m": mixture-of-
// experts models publish "8x7b" (Mixtral) and "128x17b" (Llama 4), and Gemma
// 3n publishes effective sizes "e2b"/"e4b". All of these are sizes, not
// capabilities — an earlier, narrower regex filed six of them under
// `capabilities`, which is why the shape is pinned by test below.
const SIZE_CHIP_RE = /^(?:\d+x)?\d+(?:\.\d+)?[bm]$|^e\d+b$/i;

// The site also colours size chips distinctly from capability chips. We use
// both signals rather than picking one: the regex survives a palette change,
// and the colour catches a size format we haven't seen yet. Either alone has
// a silent-misclassification failure mode.
const SIZE_CHIP_BG = "bg-[#ddf4ff]";

/** Every capability the library currently publishes, for the drift test. */
export const KNOWN_CAPABILITIES = [
  "audio",
  "cloud",
  "embedding",
  "thinking",
  "tools",
  "vision",
] as const;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the small set of HTML entities the library page's descriptions use. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const codePoint = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return entity in NAMED_ENTITIES ? NAMED_ENTITIES[entity] : match;
  });
}

/** Strips tags and collapses whitespace after entity decoding. */
function cleanText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses `title="Oct 10, 2025 8:18 PM UTC"` into ISO 8601. Returns null if
 * the title is missing or the date doesn't parse (rather than guessing).
 */
function parseUpdatedTitle(title: string | undefined): string | null {
  if (title === undefined) return null;
  const parsed = new Date(title);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Parses `https://ollama.com/library`'s HTML into catalog entries.
 *
 * Deliberately regex/string based, not DOM based: this runs both from
 * `scripts/fetch-catalog.mjs` in plain Node (no jsdom) and from tests. Each
 * model's card lives entirely inside `<a href="/library/NAME" ...> ... </a>`
 * with no nested anchors, so that anchor tag is the unit of extraction —
 * more robust than matching `<li>` boundaries, since the page also has
 * unrelated `<li>` elements (e.g. nav).
 */
export function parseLibraryIndex(html: string): CatalogModel[] {
  const models: CatalogModel[] = [];
  const entryRe = /<a href="\/library\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(html)) !== null) {
    const [, name, block] = match;

    const descriptionMatch = /<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    const description = descriptionMatch ? cleanText(descriptionMatch[1]) : "";

    const sizes: string[] = [];
    const capabilities: string[] = [];
    const chipRe = /<span\s+class="(inline-flex items-center rounded-md[^"]*)"[^>]*>([^<]*)<\/span>/g;
    let chipMatch: RegExpExecArray | null;
    while ((chipMatch = chipRe.exec(block)) !== null) {
      const [, chipClass, rawChip] = chipMatch;
      const chip = cleanText(rawChip).toLowerCase();
      if (chip === "") continue;
      if (SIZE_CHIP_RE.test(chip) || chipClass.includes(SIZE_CHIP_BG)) {
        sizes.push(chip);
      } else {
        capabilities.push(chip);
      }
    }

    // The label is singular ("&nbsp;Tag") for a model with exactly one tag.
    const tagCountMatch = /<span\s*>(\d+)<\/span>\s*<span[^>]*>&nbsp;Tags?<\/span>/.exec(block);
    const tagCount = tagCountMatch ? parseInt(tagCountMatch[1], 10) : 0;

    const updatedMatch = /<span class="flex items-center" title="([^"]*)">[\s\S]*?Updated/.exec(block);
    const updated = parseUpdatedTitle(updatedMatch ? updatedMatch[1] : undefined);

    models.push({ name, description, sizes, capabilities, tagCount, updated });
  }

  return models;
}

/**
 * Client-side search over `CATALOG`. Ranked (exact name > name-prefix >
 * name-substring > description-substring), stable within a rank, so typing
 * "qwen" surfaces `qwen` before `qwen3` before a model that merely mentions
 * Qwen in its description. A trailing `:size` (as typed for `ollama pull`,
 * e.g. "qwen3:8b") is split off before matching the name.
 */
export function searchCatalog(models: CatalogModel[], query: string): CatalogModel[] {
  const trimmed = query.trim();
  if (trimmed === "") return models;

  const lower = trimmed.toLowerCase();
  const namePart = lower.split(":", 1)[0];

  const RANK_EXACT = 0;
  const RANK_PREFIX = 1;
  const RANK_NAME_SUBSTRING = 2;
  const RANK_DESCRIPTION = 3;

  const ranked: { model: CatalogModel; rank: number }[] = [];
  for (const model of models) {
    const name = model.name.toLowerCase();
    let rank: number;
    if (name === namePart) {
      rank = RANK_EXACT;
    } else if (name.startsWith(namePart)) {
      rank = RANK_PREFIX;
    } else if (name.includes(namePart)) {
      rank = RANK_NAME_SUBSTRING;
    } else if (model.description.toLowerCase().includes(lower)) {
      rank = RANK_DESCRIPTION;
    } else {
      continue;
    }
    ranked.push({ model, rank });
  }

  // Array#sort in V8 is stable, so entries within the same rank keep their
  // original catalog order.
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.map((r) => r.model);
}
