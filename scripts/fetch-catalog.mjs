#!/usr/bin/env node
/**
 * Regenerates app/src/pull/catalog.json from https://ollama.com/library
 * (SPEC.md §5.5).
 *
 * Ollama has no registry search API, so the Pull pane's searchable catalog
 * is built at dev/CI time by scraping the library's index page and shipping
 * the result as a static JSON file. Run via `npm run catalog` from `app/`
 * (which invokes `tsx` so this plain .mjs file can import the TypeScript
 * parser directly — Node can't load .ts on its own).
 *
 * Fails loudly (non-zero exit) rather than silently committing a thin or
 * broken catalog: too few models, or too many blank descriptions, means the
 * page's markup likely drifted and `parseLibraryIndex` needs a look.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseLibraryIndex } from "../app/src/pull/catalog.ts";

const LIBRARY_URL = "https://ollama.com/library";
const MIN_MODELS = 100;
const MAX_EMPTY_DESCRIPTION_RATIO = 0.2;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "app", "src", "pull", "catalog.json");

async function main() {
  const response = await fetch(LIBRARY_URL);
  if (!response.ok) {
    throw new Error(`GET ${LIBRARY_URL} failed: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();

  const models = parseLibraryIndex(html);

  if (models.length < MIN_MODELS) {
    throw new Error(
      `parsed only ${models.length} models (need >= ${MIN_MODELS}) — ` +
        `the library page's markup likely changed shape; parseLibraryIndex needs updating`,
    );
  }

  const emptyDescriptionCount = models.filter((m) => m.description.trim() === "").length;
  const emptyDescriptionRatio = emptyDescriptionCount / models.length;
  if (emptyDescriptionRatio > MAX_EMPTY_DESCRIPTION_RATIO) {
    throw new Error(
      `${emptyDescriptionCount}/${models.length} models (${(emptyDescriptionRatio * 100).toFixed(1)}%) ` +
        `have an empty description (max ${(MAX_EMPTY_DESCRIPTION_RATIO * 100).toFixed(0)}%) — ` +
        `the description markup likely changed shape; parseLibraryIndex needs updating`,
    );
  }

  // Codepoint order, not localeCompare: this file is committed, and a
  // locale-sensitive sort would make regeneration produce a spurious diff on
  // a machine with a different LANG.
  const sorted = [...models].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const json = `${JSON.stringify(sorted, null, 2)}\n`;
  await writeFile(OUTPUT_PATH, json, "utf-8");

  const byteSize = Buffer.byteLength(json, "utf-8");
  console.log(`wrote ${sorted.length} models to ${path.relative(process.cwd(), OUTPUT_PATH)} (${byteSize} bytes)`);
}

main().catch((err) => {
  console.error(`fetch-catalog: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
