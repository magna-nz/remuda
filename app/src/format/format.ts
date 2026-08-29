/**
 * Constrained output — the per-chat `format` field (docs/SPEC-round-two.md
 * R2, docs/mockup-proposals-2.html §02).
 *
 * Pure: no React, no storage, no client. Two jobs, and neither of them is
 * validation — that belongs to tools/validate.ts, which this feature reuses
 * rather than re-implements (see conform.ts).
 *
 *  1. **The raw schema text the user is typing → a parsed JSON Schema, or
 *     the parse failure.** The text is the source of truth, exactly as
 *     tools/toolsets.ts holds its tools array: JSON in the middle of an edit
 *     does not parse, and storing the parsed form would mean either refusing
 *     to persist a half-typed schema or silently reverting to the last good
 *     one. Both throw away what the user typed. The text is persisted with
 *     the session (chat/sessions.ts `FormatConfig`) and the schema is
 *     derived from it on every read.
 *
 *  2. **The three-state mode → what goes on the wire.** `schema` sends the
 *     parsed object, `json` sends the literal string, and `off` omits the
 *     key *entirely* — not `""`, not `null`, which are both different
 *     instructions to Ollama rather than the absence of one.
 *
 * There is no Modelfile path here, on purpose: Ollama has no `PARAMETER
 * format`, so an affordance to bake this in would write a line the server
 * ignores. `format` is per-chat and only per-chat.
 */
import type { ChatFormat } from "../api/types";
import type { FormatConfig, FormatMode } from "../chat/sessions";

export type { FormatConfig, FormatMode };

/** The derived form of the pane's text: the schema, or why it isn't one. */
export interface ParsedSchema {
  /** Null whenever `error` is set; never both. */
  schema: Record<string, unknown> | null;
  /** Human-readable failure, shown in the pane. Null when it parsed. */
  error: string | null;
}

/**
 * The starter the pane opens on — the mockup's release-notes schema.
 *
 * An empty editor is a worse first run than a working example: the point of
 * the pane is the conformance card under the reply, and a user who has to
 * invent a schema before seeing one never gets there. It exercises the parts
 * the card renders differently — a required list, an array with `items`, and
 * an enum.
 */
export const STARTER_SCHEMA = `{
  "type": "object",
  "properties": {
    "summary": { "type": "string" },
    "breaking": { "type": "boolean" },
    "issues": {
      "type": "array",
      "items": { "type": "integer" }
    },
    "severity": {
      "type": "string",
      "enum": ["patch", "minor", "major"]
    }
  },
  "required": ["summary", "severity"]
}`;

/** A chat with no `format` of its own: off, with the starter ready to edit. */
export function defaultFormat(): FormatConfig {
  return { mode: "off", text: STARTER_SCHEMA };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derive the schema from the raw text.
 *
 * Empty is an error here, unlike toolsets.ts where an empty set means "no
 * tools": there is no such thing as an empty constraint. Sending `{}` would
 * be a schema that permits anything, which is `json` — a state this pane
 * already has a button for.
 */
export function parseSchema(text: string): ParsedSchema {
  if (text.trim() === "") {
    return { schema: null, error: "the response schema is empty. Write one, or switch to json" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { schema: null, error: error instanceof Error ? error.message : "invalid JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { schema: null, error: "the response schema must be a JSON object" };
  }
  return { schema: parsed, error: null };
}

/** The declared property names, in the order the schema lists them. */
export function propertyNames(schema: Record<string, unknown> | null): string[] {
  if (schema === null || !isPlainObject(schema.properties)) return [];
  return Object.keys(schema.properties);
}

/** The declared `required` names; anything non-string is ignored. */
export function requiredNames(schema: Record<string, unknown> | null): string[] {
  if (schema === null || !Array.isArray(schema.required)) return [];
  return schema.required.filter((key): key is string => typeof key === "string");
}

/** One property's sub-schema, or null when the schema doesn't declare it. */
export function propertySchema(
  schema: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (schema === null || !isPlainObject(schema.properties)) return null;
  const property = schema.properties[key];
  return isPlainObject(property) ? property : null;
}

/**
 * What one send should carry — or the reason it must not happen.
 *
 * `format` absent with `error` null is the `off` state: omit the key. An
 * `error` refuses the send outright. Sending anyway, unconstrained, is the
 * one outcome worse than an error: the reply would look like a model that
 * ignored the shape when in fact nothing ever asked for it (R2).
 */
export interface WireFormat {
  /** The `format` value for the request body; undefined omits the key. */
  format?: ChatFormat;
  /** Non-null when the send must be refused, with this shown to the user. */
  error: string | null;
}

export function wireFormat(config: FormatConfig | undefined): WireFormat {
  if (config === undefined || config.mode === "off") {
    return { error: null };
  }
  if (config.mode === "json") {
    return { format: "json", error: null };
  }
  const { schema, error } = parseSchema(config.text);
  if (schema === null) {
    return {
      error: `The response schema doesn’t parse (${error ?? "invalid JSON"}). Nothing was sent. Fix it in the Format pane, or switch the constraint off.`,
    };
  }
  return { format: schema, error: null };
}

/** The word the composer pill shows: "off", "json", "schema". */
export function formatLabel(config: FormatConfig | undefined): string {
  return config === undefined ? "off" : config.mode;
}
