/**
 * Curated "Popular" pull list (SPEC.md §5.5).
 *
 * Ollama has no registry search API, so this is bundled and static, not
 * fetched. Sizes are approximate (the actual pull reports the real total).
 */
export interface PopularModel {
  /** Tag as passed to `ollama pull`, e.g. "qwen2.5-coder:7b". */
  tag: string;
  /** "Vendor · size · one-line description", matching docs/mockup.html rows. */
  blurb: string;
  approxSizeBytes: number;
}

export const POPULAR_MODELS: PopularModel[] = [
  {
    tag: "llama3.2",
    blurb: "Meta · 3B · latest small Llama, fast on CPU",
    approxSizeBytes: 2_000_000_000,
  },
  {
    tag: "qwen2.5-coder:7b",
    blurb: "Alibaba · 7B · strong code completion",
    approxSizeBytes: 4_700_000_000,
  },
  {
    tag: "gemma2:2b",
    blurb: "Google · 2B · tiny, runs almost anywhere",
    approxSizeBytes: 1_600_000_000,
  },
  {
    tag: "nomic-embed-text",
    blurb: "Nomic AI · embedding model for RAG and search",
    approxSizeBytes: 274_000_000,
  },
  {
    tag: "phi3:mini",
    blurb: "Microsoft · 3.8B · compact, punches above its weight",
    approxSizeBytes: 2_300_000_000,
  },
];
