/**
 * What a `TEMPLATE` says about itself, independent of whether it can be
 * rendered (SPEC-round-two.md R3).
 *
 * The one question this exists to answer: **does this template reference
 * `.System`?** A template that doesn't drops the Modelfile's `SYSTEM`
 * instruction on the floor before the model ever sees it, and nothing in the
 * chat window can tell that apart from a model choosing to ignore it. The
 * pane's footer turns red on this flag, so the flag has to be right on
 * templates the renderer refuses too — which is most real ones.
 *
 * Pure, total, no throws. Same contract as `render.ts`.
 */
import { scanTemplate, type TemplateField } from "./render";

/**
 * Which template language this is.
 *
 * Ollama serves two. Older models carry a Go `text/template`; newer ones ship
 * the Jinja2 chat template embedded in their GGUF, which is a different
 * language with `{% … %}` statement blocks, `endif`/`endfor`, filters and
 * macros. Go templates have no `{%` construct at all, so the marker is
 * unambiguous.
 *
 * This distinction is not cosmetic. A Jinja template addresses the system
 * prompt through its `messages` array and never writes `.System` — so the
 * textual check below correctly returns false for it, and presenting that as
 * "your system prompt is being dropped" would be a false alarm on every
 * modern model. See `referencesSystem`.
 */
export type TemplateDialect = "go" | "jinja";

export interface TemplateAnalysis {
  /** Go `text/template`, or the Jinja2 chat template newer models ship. */
  dialect: TemplateDialect;
  /**
   * True when any action mentions `.System`.
   *
   * **Only meaningful when `dialect` is `"go"`.** For a Jinja template this
   * is always false and means nothing — Jinja has no `.System` to reference
   * — so the pane must not render the indicator at all rather than render it
   * red. A figure that can't be read honestly is absent, never zero.
   */
  referencesSystem: boolean;
  /** Distinct subset fields the template resolves, in first-seen order. */
  fields: TemplateField[];
  /** How many actions reference a field — the "N slots" readout. */
  slots: number;
  /** Verbatim sources of actions outside the subset, deduped, in order. */
  unsupported: string[];
  /** True when there is no template to speak of. */
  empty: boolean;
}

/**
 * `.System` as a field reference, anywhere inside an action: bare
 * (`{{ .System }}`), under a builtin (`{{ if or .System .Tools }}`), or off
 * the root (`{{ $.System }}`).
 *
 * Matched textually and only within actions, for two reasons. Literal text
 * that happens to contain ".System" is printed, not resolved, so it must not
 * count. And an action the renderer cannot execute still *references* the
 * field — reporting "does not reference .System" for llama3's template,
 * which plainly does, would be a false alarm on the one indicator this pane
 * is built around. False green hides the bug; false red cries wolf; matching
 * the text avoids both without pretending to parse expressions we refuse to
 * execute.
 */
const SYSTEM_REF = /\.System\b/;

export function analyseTemplate(template: string): TemplateAnalysis {
  const tokens = scanTemplate(template);
  const fields: TemplateField[] = [];
  const unsupported: string[] = [];
  let referencesSystem = false;
  let slots = 0;

  for (const token of tokens) {
    if (token.kind !== "action") continue;
    if (SYSTEM_REF.test(token.body)) referencesSystem = true;

    switch (token.action.kind) {
      case "field":
      case "if":
      case "range": {
        slots++;
        if (!fields.includes(token.action.field)) fields.push(token.action.field);
        break;
      }
      case "unsupported": {
        if (!unsupported.includes(token.source)) unsupported.push(token.source);
        break;
      }
      case "end":
        break;
    }
  }

  return {
    dialect: detectDialect(template),
    referencesSystem,
    fields,
    slots,
    unsupported,
    empty: template.trim() === "",
  };
}

/**
 * Go `text/template` or Jinja2.
 *
 * `{% … %}` is the marker: it is Jinja's statement block and has no meaning
 * in Go's template language, so a template containing one is never a Go
 * template. Everything else — including a template using Go constructs this
 * renderer refuses, like `eq` or `else` — stays `"go"`, because those are
 * still Go templates that simply fall outside the supported subset.
 *
 * Deliberately one narrow test rather than a score over several hints. A
 * misread here is worse than an unknown: calling a Go template Jinja hides
 * the `.System` indicator on exactly the model that needed it.
 */
export function detectDialect(template: string): TemplateDialect {
  return /\{%/.test(template) ? "jinja" : "go";
}

/**
 * The `RENDERER` a Modelfile declares, or null.
 *
 * Newer Ollama models select a **built-in, native prompt renderer** by name
 * (`RENDERER gemma4`) instead of expressing the whole prompt as a Go
 * template. When one is declared the `TEMPLATE` is typically a stub — gemma4
 * ships `TEMPLATE {{ .Prompt }}` — and the real prompt, system message
 * included, is assembled inside Ollama where Remuda cannot see it.
 *
 * That makes the `.System` indicator unanswerable rather than false: the
 * template genuinely does not reference `.System`, and the system prompt
 * genuinely does reach the model. Reporting red there is the same false
 * alarm as reporting it for a Jinja template.
 *
 * `RENDERER` is not modelled by `modelfile/parse.ts`, so it lives in
 * passthrough and is read back off the serialised text.
 */
export function declaredRenderer(modelfileText: string): string | null {
  const match = /^[ \t]*RENDERER[ \t]+(\S+)/im.exec(modelfileText);
  return match === null ? null : match[1];
}
