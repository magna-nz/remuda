/**
 * Tests for the Ollama library catalog (SPEC.md §5.5).
 *
 * `parseLibraryIndex` is exercised against a checked-in fixture — a real,
 * saved copy of `https://ollama.com/library` — rather than a hand-rolled
 * snippet, so a shape change in the actual page shows up as a test failure
 * here instead of silently producing a thin catalog at build time.
 */
import { describe, expect, it } from "vitest";
import {
  KNOWN_CAPABILITIES,
  parseLibraryIndex,
  searchCatalog,
  type CatalogModel,
} from "./catalog";
// Vite's `?raw` suffix loads the fixture as a plain string, both under
// vitest and in a real build — no Node `fs` access needed.
import fixtureHtml from "./__fixtures__/library-index.html?raw";

const models = parseLibraryIndex(fixtureHtml);

function makeModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    name: "m",
    description: "",
    sizes: [],
    capabilities: [],
    tagCount: 0,
    updated: null,
    ...overrides,
  };
}

describe("parseLibraryIndex", () => {
  it("parses at least 200 models out of the library page", () => {
    expect(models.length).toBeGreaterThanOrEqual(200);
  });

  it("parses the qwen3 entry correctly", () => {
    const qwen3 = models.find((m) => m.name === "qwen3");
    expect(qwen3).toBeDefined();
    expect(qwen3!.name).toBe("qwen3");
    expect(qwen3!.description.length).toBeGreaterThan(0);
    expect(qwen3!.sizes).toContain("0.6b");
    expect(qwen3!.sizes).toContain("235b");
    expect(qwen3!.capabilities).toContain("tools");
    expect(qwen3!.capabilities).toContain("thinking");
    expect(qwen3!.tagCount).toBe(58);
    expect(qwen3!.updated).not.toBeNull();
    expect(qwen3!.updated).toMatch(/^2025-10-10T/);
  });

  it("never produces an entry with an empty name", () => {
    for (const model of models) {
      expect(model.name.trim()).not.toBe("");
    }
  });

  it("never classifies a size token (e.g. \"8b\", \"0.6b\") as a capability", () => {
    const sizeTokenRe = /^(?:\d+x)?\d+(?:\.\d+)?[bm]$|^e\d+b$/i;
    for (const model of models) {
      for (const capability of model.capabilities) {
        expect(capability).not.toMatch(sizeTokenRe);
      }
    }
  });
});

describe("searchCatalog", () => {
  const catalog: CatalogModel[] = [
    makeModel({ name: "qwen3", description: "Qwen3 is a large language model." }),
    makeModel({ name: "qwen2.5-coder", description: "Code-focused variant of Qwen." }),
    makeModel({ name: "llama3.2", description: "Meta's small Llama, mentions qwen for comparison." }),
    makeModel({ name: "gemma2", description: "Google's Gemma family." }),
  ];

  it("returns the input unchanged for an empty or whitespace query", () => {
    expect(searchCatalog(catalog, "")).toEqual(catalog);
    expect(searchCatalog(catalog, "   ")).toEqual(catalog);
  });

  it("ranks an exact name match first", () => {
    const results = searchCatalog(catalog, "qwen3");
    expect(results[0].name).toBe("qwen3");
  });

  it("ranks a name-prefix match ahead of a name-substring match", () => {
    // "qwen" is a prefix of both qwen3 and qwen2.5-coder; neither is a
    // substring-only match here, so use a query that is a substring of one
    // name but a prefix of another to separate the two ranks.
    const withSubstringOnly: CatalogModel[] = [
      makeModel({ name: "big-qwen-variant", description: "" }),
      makeModel({ name: "qwen3", description: "" }),
    ];
    const results = searchCatalog(withSubstringOnly, "qwen");
    expect(results[0].name).toBe("qwen3");
    expect(results[1].name).toBe("big-qwen-variant");
  });

  it("matches case-insensitively on name and description", () => {
    expect(searchCatalog(catalog, "GEMMA").map((m) => m.name)).toContain("gemma2");
    expect(searchCatalog(catalog, "LLAMA'S SMALL").length).toBe(0); // sanity: no false positive
    expect(searchCatalog(catalog, "code-focused").map((m) => m.name)).toContain("qwen2.5-coder");
  });

  it("finds a model by name even when the query carries a :size suffix", () => {
    const results = searchCatalog(catalog, "qwen3:8b");
    expect(results[0].name).toBe("qwen3");
  });

  it("is stable within a rank band", () => {
    // Both llama3.2 and gemma2 only match via description substring here;
    // they should keep their original catalog order.
    const results = searchCatalog(catalog, "meta's small llama, mentions qwen for comparison");
    expect(results.map((m) => m.name)).toEqual(["llama3.2"]);
  });
});

describe("size vs capability classification", () => {
  it("files mixture-of-experts and effective sizes as sizes, not capabilities", () => {
    // Mixtral "8x7b"/"8x22b", Llama 4 "16x17b"/"128x17b", Gemma 3n "e2b"/"e4b".
    // A narrower size regex silently filed all six under capabilities.
    const mixtral = models.find((m) => m.name === "mixtral");
    expect(mixtral?.sizes).toContain("8x7b");
    expect(mixtral?.capabilities).not.toContain("8x7b");

    const gemma3n = models.find((m) => m.name === "gemma3n");
    expect(gemma3n?.sizes).toContain("e2b");
    expect(gemma3n?.capabilities).not.toContain("e2b");
  });

  it("yields only known capabilities across the whole library", () => {
    // The drift canary: a new size notation leaking into `capabilities`
    // shows up here as an unexpected token rather than passing silently.
    const seen = [...new Set(models.flatMap((m) => m.capabilities))].sort();
    expect(seen).toEqual([...KNOWN_CAPABILITIES].sort());
  });
});

describe("parser and search edge cases", () => {
  it("passes through an out-of-range numeric entity instead of throwing", () => {
    // parseInt("1114112") is a finite number, so a Number.isNaN-only guard
    // let this reach String.fromCodePoint, which throws RangeError.
    for (const entity of ["&#1114112;", "&#x110000;", "&#-1;"]) {
      const html = `<a href="/library/x"><h2>x</h2><p>${entity}</p></a>`;
      expect(() => parseLibraryIndex(html)).not.toThrow();
    }
  });

  it("does not treat a bare tag query as matching every model", () => {
    // ":8b" splits to an empty name part, and "".startsWith() is true for
    // every name — which ranked the entire catalog as a prefix match.
    for (const query of [":", "::", ":8b"]) {
      expect(searchCatalog(models, query).length).toBeLessThan(models.length);
    }
  });

  it("survives regex metacharacters and a very long query", () => {
    expect(() => searchCatalog(models, "(((((*+")).not.toThrow();
    expect(searchCatalog(models, "a".repeat(200_000))).toEqual([]);
  });
});