/**
 * "Copy as curl" / "Copy as ollama run" (SPEC-tuning.md T6, item 1).
 *
 * Pure — no React, no store access. Takes the same shape `chat()` on
 * `OllamaClient` takes (api/types.ts) and turns it into a command the user
 * can paste into a terminal.
 *
 * The wire mapping here is a deliberate, line-by-line mirror of
 * api/client.ts's private `wireOptions` / `wireThink` / `wireMessage` and the
 * `/api/chat` body assembly in its `chat()` method — this module cannot
 * import those (they aren't exported), so drift is a risk the tests below
 * guard against. If client.ts's wire mapping changes, this file needs the
 * matching change.
 */
import type { ChatFormat, ChatMessage, KeepAlive, RunOptions, ThinkLevel } from "../api/types";
import { DEFAULT_BASE_URL, RUN_OPTION_KEYS } from "../api/types";

/** Same argument shape as `chat()` on `OllamaClient`, minus `signal` (there is
 * nothing to abort once the request already happened) and `tools` (not yet a
 * chat feature at the call sites this lands beside). `options`, `think` and
 * `keepAlive` are optional here even though `chat()`'s `keepAlive` is
 * required — a caller exporting a past request may not know which keep_alive
 * value was actually in effect, and omitting it from the exported body is
 * more honest than guessing one. */
export interface ExportInput {
  /** Model tag, e.g. "llama3.1:8b" — the `model` field on /api/chat. */
  tag: string;
  /** Full message history sent with the request, in order. */
  messages: ChatMessage[];
  /** Sampling overrides; unset keys are omitted, exactly like the wire encoder. */
  options?: RunOptions;
  /** "off" emits literal `false`; undefined omits `think` entirely; a level
   * goes through verbatim — the same three states client.ts's `wireThink` has. */
  think?: ThinkLevel;
  /** keep_alive to include in the exported body; omitted when unknown. */
  keepAlive?: KeepAlive;
  /** Constrained output (docs/SPEC-round-two.md R2): a JSON Schema object or
   * the literal "json". Undefined omits `format`, which is what "off" is —
   * the same three states client.ts's `chat()` has. */
  format?: ChatFormat;
}

/* ── Wire mapping, mirrored from api/client.ts ─────────────────────────── */

/** Mirrors client.ts's `wireOptions`: camelCase → snake_case, unset keys
 * dropped, `null` when nothing is set. */
function wireOptions(options: RunOptions | undefined): Record<string, number> | null {
  if (!options) {
    return null;
  }
  const out: Record<string, number> = {};
  for (const [key, wireKey] of RUN_OPTION_KEYS) {
    const value = options[key];
    if (value !== undefined) {
      out[wireKey] = value;
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** The `[wireKey, value]` pairs `wireOptions` would set, in `RUN_OPTION_KEYS`
 * order — used by `asOllamaRun` to emit one `/set parameter` line per key. */
function wireOptionEntries(options: RunOptions | undefined): Array<[string, number]> {
  const entries: Array<[string, number]> = [];
  if (!options) {
    return entries;
  }
  for (const [key, wireKey] of RUN_OPTION_KEYS) {
    const value = options[key];
    if (value !== undefined) {
      entries.push([wireKey, value]);
    }
  }
  return entries;
}

/** Mirrors client.ts's `wireThink`: three states, not two — undefined omits
 * the key, "off" is literal `false`, a level goes through verbatim. */
function wireThink(think: ThinkLevel | undefined): string | boolean | null {
  if (think === undefined) return null;
  return think === "off" ? false : think;
}

/** Mirrors client.ts's `wireMessage`: role/content plus `images` when
 * non-empty. `thinking` and `imageThumbs` are deliberately dropped — the real
 * client never sends them either. */
function wireMessage(message: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.images !== undefined && message.images.length > 0) {
    out.images = message.images;
  }
  // Re-encoded, not passed through: the domain shape is `{ name, arguments }`
  // and Ollama's nests it under `function` — same as client.ts.
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    out.tool_calls = message.toolCalls.map((call) => ({
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.toolName !== undefined && message.toolName !== "") {
    out.tool_name = message.toolName;
  }
  return out;
}

/** Assembles the body in the same field order client.ts's `chat()` builds it:
 * model, messages, stream, keep_alive, then think, then options. */
function buildRequestBody(input: ExportInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.tag,
    messages: input.messages.map(wireMessage),
    stream: true,
  };
  if (input.keepAlive !== undefined) {
    body.keep_alive = input.keepAlive;
  }
  const think = wireThink(input.think);
  if (think !== null) {
    body.think = think;
  }
  const options = wireOptions(input.options);
  if (options !== null) {
    body.options = options;
  }
  if (input.format !== undefined) {
    body.format = input.format;
  }
  return body;
}

/** Wraps `value` in single quotes for a POSIX shell, escaping any single
 * quote inside it as `'\''` (close the quoted string, an escaped literal
 * quote, reopen it) — the standard way to embed a `'` in `sh`/`bash`/`zsh`
 * single-quoted strings. Without this, a prompt containing an apostrophe
 * (e.g. "it's") would break the pasted command. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact `/api/chat` request that produced (or would produce) this reply,
 * as a runnable `curl` command. `stream: true` is kept in the body — the real
 * request sends it, and dropping it here would make the pasted command behave
 * differently (curl would print the whole NDJSON stream instead of one line
 * at a time, but functionally it's still what the app actually sent).
 */
export function asCurl(input: ExportInput): string {
  const body = buildRequestBody(input);
  const json = JSON.stringify(body, null, 2);
  return `curl ${DEFAULT_BASE_URL}/api/chat -d ${shellSingleQuote(json)}`;
}

/**
 * The nearest honest `ollama run` equivalent. This is a real limit, not a
 * bug: `ollama run` has no way to submit a full multi-turn message array or
 * per-request `options`/`think` in one shot the way `/api/chat` does. So this
 * emits what CAN be reproduced faithfully — the model tag, `/set parameter`
 * lines for any run options that are set, and the final user prompt — and a
 * `#` comment for anything it can't: earlier turns, `think`, and images. A
 * command that silently dropped those would look complete and lie by
 * omission; the comments are the honest alternative.
 */
export function asOllamaRun(input: ExportInput): string {
  const lines: string[] = [`ollama run ${input.tag}`];

  for (const [wireKey, value] of wireOptionEntries(input.options)) {
    lines.push(`/set parameter ${wireKey} ${value}`);
  }

  if (input.think !== undefined) {
    lines.push(
      `# think: ${input.think} can't be reproduced here — it's an /api/chat request field, not a PARAMETER 'ollama run' understands`,
    );
  }

  if (input.format !== undefined) {
    // Same limit as `think`, and worth naming for the same reason: there is
    // no `PARAMETER format`, so a pasted `ollama run` cannot constrain
    // decoding at all. A command that dropped it silently would produce
    // unconstrained output while looking like a faithful reproduction.
    lines.push(
      "# format: constrained output can't be reproduced here — it's an /api/chat request field, and there is no PARAMETER format",
    );
  }

  const hasImages = input.messages.some((m) => m.images !== undefined && m.images.length > 0);
  if (hasImages) {
    lines.push(
      "# one or more messages attached images — 'ollama run' takes a local file path, not embedded image data, so they are not reproduced here",
    );
  }

  const userMessages = input.messages.filter((m) => m.role === "user");
  const hasEarlierTurns =
    userMessages.length > 1 || input.messages.some((m) => m.role === "assistant" || m.role === "system");
  if (hasEarlierTurns) {
    lines.push(
      "# only the final prompt is shown below — 'ollama run' can't replay a full multi-turn conversation in one command",
    );
  }

  const lastUser = userMessages[userMessages.length - 1];
  if (lastUser !== undefined) {
    lines.push(lastUser.content);
  } else {
    lines.push("# no user message to prompt with");
  }

  return lines.join("\n");
}
