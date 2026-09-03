/**
 * The rendered prompt — a renderer for a *documented subset* of Go
 * `text/template` (SPEC-round-two.md R3, docs/mockup-proposals-2.html §03).
 *
 * Ollama has no "render this template" endpoint, so the only way to show a
 * user the string their model actually receives is to execute the template
 * here. That is a real risk: a renderer that quietly disagrees with the
 * server's is worse than no renderer at all, because the pane exists to be
 * trusted about a bug (`TEMPLATE` dropping `SYSTEM`) that is invisible
 * everywhere else.
 *
 * So the subset is closed and small, and everything outside it **fails
 * loudly**:
 *
 *   - actions: `{{ if .X }}`, `{{ range .Messages }}`, `{{ end }}`, `{{ .X }}`
 *   - fields:  `.System` `.Prompt` `.Messages` `.Tools` `.Role` `.Content`
 *   - Go's `{{-` / `-}}` whitespace trim markers
 *
 * Deliberately **not** supported, and each one returns a failure naming the
 * action rather than a guess: `else`, `with`, `template`/`block`/`define`,
 * `$variables`, Go template comments, pipelines (`|`), and every builtin
 * (`eq`, `or`, `and`, `len`, `index`, …). Templates using them are common —
 * llama3's is one — and for those the pane shows the raw template and says
 * why. That is the designed outcome, not a gap.
 *
 * Two laws, in the register of `modelfile/parse.ts`:
 *
 *   1. **Total.** Nothing here throws, on any input, ever. Malformed
 *      templates come back as a `RenderFailure`.
 *   2. **Never guess.** An action the subset does not cover stops the render
 *      and is named in the result. There is no partial render and no
 *      best-effort substitution.
 *
 * Pure by construction: no React, no store, no API client. Data in, text or
 * a failure out.
 */

/** The fields the subset resolves. Anything else is an unsupported action. */
export const TEMPLATE_FIELDS = [
  "System",
  "Prompt",
  "Messages",
  "Tools",
  "Role",
  "Content",
] as const;

export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

function asField(name: string): TemplateField | null {
  return (TEMPLATE_FIELDS as readonly string[]).includes(name)
    ? (name as TemplateField)
    : null;
}

/** A parsed `{{ … }}` action. `unsupported` is everything outside the subset. */
export type TemplateAction =
  | { kind: "field"; field: TemplateField }
  | { kind: "if"; field: TemplateField }
  | { kind: "range"; field: TemplateField }
  | { kind: "end" }
  | { kind: "unsupported" };

/** Literal template text, between (or around) actions. */
export interface TextToken {
  kind: "text";
  text: string;
}

export interface ActionToken {
  kind: "action";
  /** Verbatim source including delimiters and trim markers, e.g. `{{- if .System }}`. */
  source: string;
  /** The action body with delimiters, trim markers and outer space removed. */
  body: string;
  /** `{{-` — trim the preceding text's trailing whitespace. */
  trimLeft: boolean;
  /** `-}}` — trim the following text's leading whitespace. */
  trimRight: boolean;
  action: TemplateAction;
}

export type TemplateToken = TextToken | ActionToken;

const OPEN = "{{";
const CLOSE = "}}";

/** Go's definition: space, tab, CR, LF. Used by the trim markers. */
const GO_SPACE = /[ \t\r\n]/;

function trimGoRight(text: string): string {
  let end = text.length;
  while (end > 0 && GO_SPACE.test(text[end - 1])) end--;
  return text.slice(0, end);
}

function trimGoLeft(text: string): string {
  let start = 0;
  while (start < text.length && GO_SPACE.test(text[start])) start++;
  return text.slice(start);
}

/**
 * Parse one action body (delimiters already stripped, outer space trimmed).
 *
 * Every branch that cannot be resolved with certainty lands on
 * `unsupported` — that is the whole safety property. In particular
 * `{{ range .Tools }}` is unsupported: `.Tools` is a string here, and
 * guessing at how Go would iterate it is exactly the kind of invention this
 * module refuses.
 */
function parseAction(body: string): TemplateAction {
  if (body === "end") return { kind: "end" };

  const control = /^(if|range)[ \t\r\n]+(\S+)$/.exec(body);
  if (control !== null) {
    const [, keyword, operand] = control;
    const ref = /^\.([A-Za-z][A-Za-z0-9]*)$/.exec(operand);
    const field = ref === null ? null : asField(ref[1]);
    if (field === null) return { kind: "unsupported" };
    // `range` iterates one thing in this subset, and it is `.Messages`.
    if (keyword === "range" && field !== "Messages") return { kind: "unsupported" };
    return keyword === "if" ? { kind: "if", field } : { kind: "range", field };
  }

  const ref = /^\.([A-Za-z][A-Za-z0-9]*)$/.exec(body);
  if (ref !== null) {
    const field = asField(ref[1]);
    if (field !== null) return { kind: "field", field };
  }

  return { kind: "unsupported" };
}

/**
 * Split a template into literal text and actions, applying the `{{-` / `-}}`
 * trim markers to the neighbouring text.
 *
 * Total: an unterminated `{{` yields a final action token whose source runs
 * to the end of the input and whose action is `unsupported`, so the render
 * refuses it by the same path as any other action it cannot execute.
 *
 * Known simplification, stated rather than hidden: the scan takes the first
 * `}}` it finds, so a `}}` inside a quoted string closes the action early.
 * Every such action is outside the subset anyway (the subset has no string
 * literals), so the only consequence is which text gets named in the
 * failure — never a wrong render.
 */
export function scanTemplate(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let i = 0;

  while (i < template.length) {
    const open = template.indexOf(OPEN, i);
    if (open === -1) {
      tokens.push({ kind: "text", text: template.slice(i) });
      break;
    }
    if (open > i) tokens.push({ kind: "text", text: template.slice(i, open) });

    const close = template.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) {
      tokens.push({
        kind: "action",
        source: template.slice(open),
        body: template.slice(open + OPEN.length).trim(),
        trimLeft: false,
        trimRight: false,
        action: { kind: "unsupported" },
      });
      break;
    }

    const source = template.slice(open, close + CLOSE.length);
    let inner = template.slice(open + OPEN.length, close);
    // Go requires whitespace after `{{-` and before `-}}`; without it the
    // `-` is part of the expression (`{{-3}}` is the number -3). Honouring
    // that keeps us from trimming text Go would have kept.
    const trimLeft = /^-[ \t\r\n]/.test(inner);
    if (trimLeft) inner = inner.slice(1);
    const trimRight = /[ \t\r\n]-$/.test(inner);
    if (trimRight) inner = inner.slice(0, -1);
    const body = inner.trim();

    tokens.push({
      kind: "action",
      source,
      body,
      trimLeft,
      trimRight,
      action: parseAction(body),
    });

    i = close + CLOSE.length;
  }

  // Apply the trim markers in a second pass, so each marker sees the whole
  // neighbouring text token rather than a half-built one.
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (token.kind !== "action") continue;
    const before = tokens[t - 1];
    if (token.trimLeft && before?.kind === "text") {
      before.text = trimGoRight(before.text);
    }
    const after = tokens[t + 1];
    if (token.trimRight && after?.kind === "text") {
      after.text = trimGoLeft(after.text);
    }
  }

  return tokens;
}

/** One transcript entry as the template sees it. */
export interface TemplateMessage {
  role: string;
  content: string;
}

/**
 * The data a template is rendered against.
 *
 * Every field is optional and defaults to its Go zero value, because that is
 * what a template's `{{ if }}` is testing: an absent system prompt is the
 * empty string, and `{{ if .System }}` is false for it.
 */
export interface TemplateData {
  system?: string;
  prompt?: string;
  messages?: TemplateMessage[];
  tools?: string;
}

/**
 * Rendered output, split so the pane can mark what was substituted. A
 * `fill` is a value that came from the data; everything else is the
 * template's own bytes.
 */
export type RenderSegment =
  | { kind: "literal"; text: string }
  | { kind: "fill"; field: TemplateField; text: string };

export interface RenderSuccess {
  ok: true;
  /** The rendered prompt. Always equals the segments concatenated. */
  text: string;
  segments: RenderSegment[];
}

export interface RenderFailure {
  ok: false;
  /**
   * `unsupported` — an action outside the documented subset.
   * `structure` — an `if`/`range` with no `end`, or an `end` with no opener.
   */
  kind: "unsupported" | "structure";
  /** The offending action's verbatim source, e.g. `{{ if eq .Role "user" }}`. */
  action: string;
  /** One sentence, ready to show. */
  message: string;
}

export type RenderResult = RenderSuccess | RenderFailure;

const EMPTY_MESSAGE: TemplateMessage = { role: "", content: "" };

/** Which `.` a block body is executing against. */
type Scope = { kind: "root" } | { kind: "message"; message: TemplateMessage };

interface Resolved {
  /** Printed value. `null` when the field is not printable in this scope. */
  text: string | null;
  truthy: boolean;
}

/**
 * Resolve a field against the current dot.
 *
 * Scope matters and is enforced rather than papered over: inside
 * `{{ range .Messages }}` the dot *is* a message, so `.System` is not
 * reachable and `.Role` is — and outside the range it is the other way
 * round. Go fails on the mismatch; so do we, rather than reaching for the
 * root and inventing a value the server would never have produced.
 */
function resolve(field: TemplateField, scope: Scope, data: Required<TemplateData>): Resolved | null {
  if (scope.kind === "message") {
    switch (field) {
      case "Role":
        return { text: scope.message.role, truthy: scope.message.role !== "" };
      case "Content":
        return { text: scope.message.content, truthy: scope.message.content !== "" };
      default:
        return null;
    }
  }
  switch (field) {
    case "System":
      return { text: data.system, truthy: data.system !== "" };
    case "Prompt":
      return { text: data.prompt, truthy: data.prompt !== "" };
    case "Tools":
      return { text: data.tools, truthy: data.tools !== "" };
    case "Messages":
      // Iterable and testable, but not printable: Go would format the slice
      // itself, and reproducing that formatting would be a guess.
      return { text: null, truthy: data.messages.length > 0 };
    default:
      return null;
  }
}

function scopeError(field: TemplateField, scope: Scope, source: string): RenderFailure {
  const where =
    scope.kind === "message"
      ? "is not available inside {{ range .Messages }}"
      : "is only available inside {{ range .Messages }}";
  return {
    ok: false,
    kind: "unsupported",
    action: source,
    message: `Unsupported template action ${source}. .${field} ${where}.`,
  };
}

function unsupported(source: string): RenderFailure {
  return {
    ok: false,
    kind: "unsupported",
    action: source,
    message: `Unsupported template action ${source}. Showing the raw template.`,
  };
}

/** Cursor into the token list; shared by every level of the walk. */
interface Cursor {
  i: number;
}

type BlockOutcome = { ok: true; closed: boolean } | RenderFailure;

/**
 * Execute tokens until this block's `{{ end }}` (consumed) or the input runs
 * out. `emit` false means "walk but produce nothing" — a false `if` branch,
 * or a `range` over an empty list.
 *
 * Skipped blocks are still walked and still validated. Go parses the whole
 * template before executing any of it, so an unsupported action in a branch
 * that happens not to fire is still an unsupported template; treating it as
 * fine would let the pane render confidently today and wrongly tomorrow when
 * a system prompt is added.
 */
function execBlock(
  tokens: TemplateToken[],
  cur: Cursor,
  scope: Scope,
  data: Required<TemplateData>,
  out: RenderSegment[],
  emit: boolean,
): BlockOutcome {
  while (cur.i < tokens.length) {
    const token = tokens[cur.i];
    cur.i++;

    if (token.kind === "text") {
      if (emit && token.text !== "") out.push({ kind: "literal", text: token.text });
      continue;
    }

    switch (token.action.kind) {
      case "unsupported":
        return unsupported(token.source);

      case "end":
        return { ok: true, closed: true };

      case "field": {
        const value = resolve(token.action.field, scope, data);
        if (value === null || value.text === null) {
          if (token.action.field === "Messages" && scope.kind === "root") {
            return {
              ok: false,
              kind: "unsupported",
              action: token.source,
              message:
                `Unsupported template action ${token.source}. .Messages can only be used ` +
                "with {{ range }} or {{ if }}.",
            };
          }
          return scopeError(token.action.field, scope, token.source);
        }
        if (emit && value.text !== "") {
          out.push({ kind: "fill", field: token.action.field, text: value.text });
        }
        continue;
      }

      case "if": {
        const value = resolve(token.action.field, scope, data);
        if (value === null) return scopeError(token.action.field, scope, token.source);
        const inner = execBlock(tokens, cur, scope, data, out, emit && value.truthy);
        if (!inner.ok) return inner;
        if (!inner.closed) {
          return {
            ok: false,
            kind: "structure",
            action: token.source,
            message: `${token.source} has no matching {{ end }}.`,
          };
        }
        continue;
      }

      case "range": {
        if (scope.kind === "message") {
          return {
            ok: false,
            kind: "unsupported",
            action: token.source,
            message: `Unsupported template action ${token.source}. Nested {{ range }} is outside the subset.`,
          };
        }
        const bodyStart = cur.i;
        const messages = data.messages;
        // An empty list still has to be walked once, to find the matching
        // `{{ end }}` and to validate the body — with a stand-in message so
        // `.Role`/`.Content` resolve in the scope they really have.
        const items = messages.length > 0 ? messages : [EMPTY_MESSAGE];
        const emitting = emit && messages.length > 0;
        let afterEnd = -1;
        for (const message of items) {
          cur.i = bodyStart;
          const inner = execBlock(
            tokens,
            cur,
            { kind: "message", message },
            data,
            out,
            emitting,
          );
          if (!inner.ok) return inner;
          if (!inner.closed) {
            return {
              ok: false,
              kind: "structure",
              action: token.source,
              message: `${token.source} has no matching {{ end }}.`,
            };
          }
          afterEnd = cur.i;
        }
        cur.i = afterEnd;
        continue;
      }
    }
  }

  return { ok: true, closed: false };
}

/** Adjacent literals are merged; fills are kept apart so each stays markable. */
function compact(segments: RenderSegment[]): RenderSegment[] {
  const out: RenderSegment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (segment.kind === "literal" && last?.kind === "literal") {
      out[out.length - 1] = { kind: "literal", text: last.text + segment.text };
      continue;
    }
    out.push(segment);
  }
  return out;
}

/**
 * Render `template` against `data`.
 *
 * Returns the rendered text *or* a failure naming the action that stopped
 * it. Never throws, never renders part of a template it did not fully
 * understand.
 */
export function renderTemplate(template: string, data: TemplateData): RenderResult {
  const filled: Required<TemplateData> = {
    system: data.system ?? "",
    prompt: data.prompt ?? "",
    messages: data.messages ?? [],
    tools: data.tools ?? "",
  };

  const tokens = scanTemplate(template);
  const segments: RenderSegment[] = [];
  const cur: Cursor = { i: 0 };
  const outcome = execBlock(tokens, cur, { kind: "root" }, filled, segments, true);

  if (!outcome.ok) return outcome;
  if (outcome.closed) {
    // We stopped on an `{{ end }}` that no `if`/`range` had opened.
    return {
      ok: false,
      kind: "structure",
      action: "{{ end }}",
      message: "{{ end }} with no matching {{ if }} or {{ range }}.",
    };
  }

  const compacted = compact(segments);
  return {
    ok: true,
    text: compacted.map((s) => s.text).join(""),
    segments: compacted,
  };
}
