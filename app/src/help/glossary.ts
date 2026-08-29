/**
 * The glossary behind `<Term>` (docs/SPEC-round-two.md R5, layer 3).
 *
 * One flat map, so a word defined here is defined everywhere it appears —
 * the load pane, the editor form, the run controls, the fit predictor — for
 * free, because they all render the same component.
 *
 * **Definitions are written for someone using Remuda, not for someone
 * reading Ollama's API reference.** They say what the thing does to your
 * machine and your replies, name the trade-off, and stop. Two or three
 * sentences, no parameter tables, no ranges the UI already enforces. Where
 * a fact is worth having but doesn't fit that budget, it goes in `extra`,
 * which renders smaller and last.
 */

export interface GlossaryEntry {
  /** The word as it is written in the UI — the popover's heading. */
  term: string;
  /** Two or three plain sentences. */
  definition: string;
  /** One optional aside: a rule of thumb, or the gotcha that follows. */
  extra?: string;
}

/**
 * Keyed by the machine word itself. Lookup is case-insensitive (see
 * `lookupTerm`), so `KV cache` matches however a caller capitalises it.
 */
export const GLOSSARY: Record<string, GlossaryEntry> = {
  num_ctx: {
    term: "num_ctx",
    definition:
      "How much text the model can hold at once, counted in tokens — the conversation so far plus the reply it is about to write. Raising it uses more memory, and Ollama has to reload the model to change it.",
    extra: "A token is roughly ¾ of a word.",
  },
  num_gpu: {
    term: "num_gpu",
    definition:
      "How many of the model's layers Ollama puts on the graphics card. Whatever is left over runs on the CPU, which is far slower — so lowering this is how you get a model to load at all when it doesn't quite fit.",
    extra: "Set as the model loads, like num_ctx. Changing it reloads the model.",
  },
  "kv cache": {
    term: "KV cache",
    definition:
      "The model's working memory for the conversation so far, held next to the weights the whole time it is loaded. It grows with the context length, which is why raising num_ctx costs memory before you have typed anything.",
  },
  quantise: {
    term: "quantise",
    definition:
      "Storing the model's numbers at lower precision so it takes less memory and runs faster. You give up a little accuracy for a lot of room — q4 is the usual trade. Remuda can quantise a variant as you save it.",
  },
  keep_alive: {
    term: "keep_alive",
    definition:
      "How long Ollama keeps the model in memory after your last message. Until it runs out the next reply starts immediately; after that the model is unloaded and the one after it waits for a fresh load.",
  },
  seed: {
    term: "seed",
    definition:
      "Fixes the random choices the model makes, so the same prompt comes back with the same answer every time. Pin it while you are comparing two Modelfiles — otherwise you cannot tell a real change from ordinary randomness.",
  },
  temperature: {
    term: "temperature",
    definition:
      "How adventurous the model is when it picks each next word. Low keeps it predictable and repetitive; high makes it more varied and more likely to wander away from what you asked.",
  },
  top_p: {
    term: "top_p",
    definition:
      "Keeps the model choosing from the likeliest words only, up to a share of the total probability. Lower cuts off the long tail of odd words; at 1 nothing is excluded. Usually left alone unless temperature on its own isn't doing it.",
  },
  "tokens/s": {
    term: "tokens/s",
    definition:
      "How fast the reply is being written, in tokens per second. It is the number to watch when a model spills out of the graphics card — running partly on the CPU can drop it tenfold.",
  },
  modelfile: {
    term: "Modelfile",
    definition:
      "The recipe for a model: which one it starts from, its system prompt, and the settings baked in alongside. Saving one creates a new named model you can chat to, and leaves the one it came from untouched.",
  },
  variant: {
    term: "variant",
    definition:
      "A model you built from a Modelfile, sharing its weights with the model it came from. Variants are how you keep several versions of a system prompt side by side without downloading anything twice.",
  },
};

/**
 * The entry for a word, or undefined if it isn't in the glossary.
 *
 * Case- and space-insensitive so callers can pass the word as their surface
 * spells it (`KV cache`, `kv cache`). An unknown word is not an error: the
 * component falls back to rendering the word plainly, because a missing
 * definition should cost the reader nothing.
 */
export function lookupTerm(name: string): GlossaryEntry | undefined {
  return GLOSSARY[name] ?? GLOSSARY[name.trim().toLowerCase()];
}
