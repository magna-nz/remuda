/**
 * Model grouping for the load pane (SPEC.md §5.1).
 *
 * Ollama hands us tags, not a hierarchy: nothing in /api/tags or /api/show
 * says `some-model-q4` and `some-model-q8` are the same model at two
 * quantisations. That grouping has to be *derived*, and this module owns the
 * rule.
 *
 * The rule is name-based, using each model's reported quantisation as the
 * authority for what to strip. It deliberately errs toward NOT merging:
 *
 *   - Under-grouping costs a slightly longer list, where a model opens onto a
 *     single-quant drill-down. Visible and self-correcting.
 *   - Over-grouping hides a model inside another model's quant picker, where
 *     the user won't look, and Load silently sends weights they didn't pick.
 *
 * The failure modes aren't symmetric, so when the rule is unsure it leaves a
 * tag on its own. We never group on `family`/`parameterSize` — those describe
 * a model rather than identify it, and would collapse a `-coding` build
 * into the stock model it shares a family with (and every fine-tune into
 * its base).
 */
import type { Model, ModelGroup } from "../api/types";

/** One installed quantisation of a model: the weights, plus its tunings. */
export interface QuantOption {
  /** The installed base tag carrying these weights, e.g. "qwen…-q4:latest". */
  tag: string;
  /**
   * The quantisation to show, e.g. "Q4_K_M". Usually what the server reports,
   * but the tag's own marker wins when the two disagree — see quantLabel.
   */
  quantization: string;
  /** Exactly what /api/show reported, kept even when the label disagrees. */
  reportedQuantization: string;
  sizeBytes: number;
  /** In memory right now. */
  isLoaded: boolean;
  /** Tuned Modelfiles built FROM this exact tag (SPEC §5.1). */
  variants: Model[];
}

/** A model: the display identity, with its installed quantisations under it. */
export interface ModelEntry {
  /** Derived group key — the tag with its quant marker removed. */
  key: string;
  family: string;
  parameterSize: string;
  quants: QuantOption[];
}

/**
 * Quant tokens to look for in a tag, longest first, derived from the reported
 * level. "Q4_K_M" also matches a bare "-q4", which is how locally-created
 * models tend to be named; "F16" also answers to "fp16".
 */
function quantTokens(quantization: string): string[] {
  const level = quantization.trim().toLowerCase();
  if (level === "" || level === "unknown") return [];
  const tokens = new Set<string>([level, level.replace(/_/g, "-"), level.replace(/[_-]/g, "")]);
  // Leading run before the first separator: "q4_k_m" → "q4", "f16" → "f16".
  const short = /^[a-z]*\d+/.exec(level)?.[0];
  if (short !== undefined && short !== "") {
    tokens.add(short);
    if (short === "f16") tokens.add("fp16");
    if (short === "fp16") tokens.add("f16");
  }
  return [...tokens].sort((a, b) => b.length - a.length);
}

/**
 * A quant-looking segment of a tag, matched maximally so "q4_K_M" comes back
 * whole rather than as a bare "q4". Independent of what the server reported.
 */
const NAMED_QUANT = /(^|[-_:.])((?:i?q\d(?:_[a-z0-9]+)*)|f16|fp16|bf16|f32|int8)(?=$|[-_:.])/i;

function quantFromName(tag: string): string | null {
  return NAMED_QUANT.exec(tag)?.[2] ?? null;
}

const normalize = (s: string): string => s.toLowerCase().replace(/[-_]/g, "");

/**
 * What to call this quantisation.
 *
 * Ollama's reported `quantization_level` is not always right: a model built
 * with `ollama create` can inherit its parent's details, so a 31.5 GB Q8 build
 * cheerfully reports Q4_K_M. When the tag's own marker contradicts the
 * reported level, the name wins — it's what distinguishes two installed tags,
 * and it's what the size corroborates. The reported value is kept alongside.
 */
export function quantLabel(tag: string, reported: string): string {
  const named = quantFromName(tag);
  if (named === null) return reported;
  // "q4" agreeing with a more specific "Q4_K_M" isn't a contradiction.
  if (reported !== "" && normalize(reported).startsWith(normalize(named))) return reported;
  return named.toUpperCase();
}

/**
 * Remove one quant token from a tag, boundary-aware so `q4` inside a name like
 * `seq40` can't match, and taking the adjoining separator with it so
 * `llama4:8b-q4_K_M` → `llama4:8b` rather than `llama4:8b-`.
 */
function stripToken(tag: string, tokens: string[]): string | null {
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[-_:.])${escaped}(?=$|[-_:.])`, "i");
    const match = pattern.exec(tag);
    if (match === null) continue;
    const start = match.index + (match[1] === "" ? 0 : match[1].length);
    let stripped = tag.slice(0, start) + tag.slice(start + token.length);
    // The leading separator was kept only when it opened the tag; drop a now
    // doubled or dangling one ("a--b" → "a-b", "a-:latest" → "a:latest").
    stripped = stripped.replace(/([-_])(?=[-_:])/g, "").replace(/[-_]$/, "");
    if (stripped !== "" && stripped !== ":latest") return stripped;
  }
  return null;
}

/**
 * The tag with its quant marker removed — the group key. Returns null when
 * there's no marker to remove, which is the signal to leave this tag as a
 * model of its own.
 *
 * The reported level is tried first, then the tag's own marker: a model whose
 * metadata lies about its quantisation (see quantLabel) still groups by name.
 */
export function stripQuant(tag: string, quantization: string): string | null {
  const byReported = stripToken(tag, quantTokens(quantization));
  if (byReported !== null) return byReported;
  const named = quantFromName(tag);
  return named === null ? null : stripToken(tag, [named]);
}

/** Display name for a group key: ":latest" is noise. */
export function displayKey(key: string): string {
  return key.endsWith(":latest") ? key.slice(0, -":latest".length) : key;
}

/**
 * Fold the client's base→variants groups into one entry per model.
 *
 * Input order is preserved: entries appear in first-seen order, and each
 * entry's quants in the order their tags arrived.
 */
export function groupByModel(groups: ModelGroup[]): ModelEntry[] {
  /** Output in first-seen order. */
  const entries: ModelEntry[] = [];
  /** Group keys still open to absorbing another quantisation. */
  const mergeable = new Map<string, ModelEntry>();

  const toQuant = (group: ModelGroup): QuantOption => ({
    tag: group.base.tag,
    quantization: quantLabel(group.base.tag, group.base.quantization),
    reportedQuantization: group.base.quantization,
    sizeBytes: group.base.sizeBytes,
    isLoaded: group.base.isLoaded,
    variants: group.variants,
  });

  for (const group of groups) {
    const quant = toQuant(group);
    // No marker to strip: the tag is its own model, and its own name is the
    // key — so a plain `foo:latest` and a `foo-q8:latest` still meet.
    const key = stripQuant(group.base.tag, group.base.quantization) ?? group.base.tag;
    const target = mergeable.get(key);

    // Collision guard: two tags in one (model, quantisation) cell means the
    // merge was wrong — they're different models that happen to share a
    // derived name. Keep them apart rather than picking a winner. The cell is
    // keyed on the *displayed* quant, since that's what the user picks by.
    const collides = target !== undefined && target.quants.some((q) => q.quantization === quant.quantization);

    if (target !== undefined && !collides) {
      target.quants.push(quant);
      continue;
    }
    const entry: ModelEntry = {
      key: collides ? group.base.tag : key,
      family: group.base.family,
      parameterSize: group.base.parameterSize,
      quants: [quant],
    };
    entries.push(entry);
    // A colliding tag stands alone and doesn't claim the shared key.
    if (!collides) mergeable.set(key, entry);
  }

  return entries;
}

/** Total tuned Modelfiles across a model's installed quants. */
export function variantCount(entry: ModelEntry): number {
  return entry.quants.reduce((n, q) => n + q.variants.length, 0);
}
