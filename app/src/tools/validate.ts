/**
 * Tool-call validation (docs/SPEC-tuning.md T3).
 *
 * A hand-rolled subset of JSON Schema — `type`, `enum`, `required`,
 * `properties` — and **deliberately not a dependency**. The whole feature is
 * the verdict, not the rendering: a pane that pretty-prints `tool_calls` is a
 * nicety, one that says *`unit`: not in enum [celsius, fahrenheit]* is a test
 * harness. A schema validator off npm would drag in draft-2020 semantics
 * (`$ref`, `allOf`, format assertions) that this pane has no way to explain
 * to the user, and would report them in a vocabulary the card cannot render.
 *
 * Pure — no React, no storage, no client. Given a ToolCall (whose `arguments`
 * Ollama already delivered as a parsed object; this module never calls
 * JSON.parse on it) and the raw tools array the user authored, it produces
 * one verdict per call and one per supplied argument.
 */
import type { ToolCall } from "../api/types";

/** A tool as declared in the user's JSON, reduced to what we can judge against. */
export interface ToolDef {
  name: string;
  description: string | null;
  /**
   * The declared `parameters` schema. `null` when the tool declares none —
   * which is a tool that takes no arguments *as far as we can tell*, and so
   * one whose call we decline to judge argument-by-argument.
   */
  parameters: Record<string, unknown> | null;
}

/** Per-argument outcome. Exactly the four the card renders. */
export type ArgVerdict = "ok" | "wrong type" | "not in enum" | "unknown key";

export interface ArgCheck {
  key: string;
  value: unknown;
  verdict: ArgVerdict;
  /**
   * The note the card shows, verdict included — "ok", "unknown key",
   * "wrong type · expected number", "not in enum [celsius, fahrenheit]".
   * Built here so the display string and the judgement can't drift apart.
   */
  detail: string;
}

export interface CallVerdict {
  name: string;
  /** A tool of this name exists in the authored schema. */
  matched: boolean;
  /**
   * One entry per argument the model supplied, in the order it supplied them.
   * Empty when the call named no tool we know: without a schema there is
   * nothing to judge against, and inventing verdicts would be worse than
   * saying "no such tool" once and showing the raw arguments unbadged.
   */
  args: ArgCheck[];
  /** `required` keys the model omitted. Empty when the tool didn't match. */
  missing: string[];
  /** Matched, every supplied argument ok, nothing required missing. */
  valid: boolean;
}

/** The header count that turns a session into a finding. */
export interface Tally {
  calls: number;
  valid: number;
  malformed: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  // Both traps in one line: typeof null === "object", and an array is an
  // object too. Neither is a JSON Schema "object".
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Tool definitions off the raw array the user typed.
 *
 * The shape Ollama takes is OpenAI's — `{ type: "function", function: { name,
 * description, parameters } }` — and that is what the starters ship. A bare
 * `{ name, parameters }` is accepted too: people write it, and rejecting it
 * would report every call as "no such tool", which reads as a model failure
 * when it is a schema typo. Anything without a string `name` is skipped
 * rather than coerced into a nameless tool nothing can ever match.
 */
export function toolDefs(tools: unknown[]): ToolDef[] {
  const defs: ToolDef[] = [];
  for (const entry of tools) {
    if (!isPlainObject(entry)) continue;
    const source = isPlainObject(entry.function) ? entry.function : entry;
    const name = source.name;
    if (typeof name !== "string" || name === "") continue;
    defs.push({
      name,
      description: typeof source.description === "string" ? source.description : null,
      parameters: isPlainObject(source.parameters) ? source.parameters : null,
    });
  }
  return defs;
}

/**
 * The JSON Schema type name for a value, as this validator reckons it.
 *
 * `integer` is not `number` — a whole number reports "integer", and the type
 * check below is the one that decides whether that satisfies a `number`
 * declaration (it does; the reverse does not).
 */
export function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** Does `value` satisfy one declared type name? */
function matchesOneType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    // A JSON `number` covers integers too; `integer` does not cover 1.5.
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      // A type keyword this subset doesn't implement is not a failure to
      // report at the user: we can't judge it, so we don't.
      return true;
  }
}

/** `type` may be a string or an array of them; an array means "any of". */
function matchesType(value: unknown, declared: unknown): boolean {
  if (typeof declared === "string") return matchesOneType(value, declared);
  if (Array.isArray(declared)) {
    const names = declared.filter((t): t is string => typeof t === "string");
    return names.length === 0 || names.some((t) => matchesOneType(value, t));
  }
  return true;
}

function typeLabel(declared: unknown): string {
  if (typeof declared === "string") return declared;
  if (Array.isArray(declared)) {
    return declared.filter((t) => typeof t === "string").join(" | ");
  }
  return "";
}

/** How an enum member reads in the note: strings bare, everything else JSON. */
function enumLabel(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Enums of objects/arrays are rare but legal; structural equality by
  // serialisation is enough for a list the user hand-wrote.
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function checkArg(key: string, value: unknown, properties: Record<string, unknown> | null): ArgCheck {
  if (properties !== null && !hasOwn(properties, key)) {
    return { key, value, verdict: "unknown key", detail: "unknown key" };
  }
  const schema = properties === null ? undefined : properties[key];
  if (!isPlainObject(schema)) {
    // Declared with no schema body (or no `properties` at all): nothing to
    // check, so "ok" means "not judged", not "verified".
    return { key, value, verdict: "ok", detail: "ok" };
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    const expected = typeLabel(schema.type);
    return {
      key,
      value,
      verdict: "wrong type",
      detail: `wrong type · expected ${expected}, got ${jsonTypeOf(value)}`,
    };
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((member) => sameValue(member, value))) {
    return {
      key,
      value,
      verdict: "not in enum",
      detail: `not in enum [${schema.enum.map(enumLabel).join(", ")}]`,
    };
  }
  return { key, value, verdict: "ok", detail: "ok" };
}

function propertiesOf(parameters: Record<string, unknown> | null): Record<string, unknown> | null {
  if (parameters === null) return null;
  return isPlainObject(parameters.properties) ? parameters.properties : null;
}

function requiredOf(parameters: Record<string, unknown> | null): string[] {
  if (parameters === null || !Array.isArray(parameters.required)) return [];
  return parameters.required.filter((key): key is string => typeof key === "string");
}

/**
 * Judge one tool call against the tools the user authored.
 *
 * `call.arguments` arrives from the client already parsed (Ollama sends an
 * object, unlike the OpenAI wire format it borrows from) — this function
 * reads it as an object and never parses it.
 */
export function validateCall(call: ToolCall, tools: unknown[]): CallVerdict {
  const def = toolDefs(tools).find((d) => d.name === call.name) ?? null;
  if (def === null) {
    return { name: call.name, matched: false, args: [], missing: [], valid: false };
  }
  const properties = propertiesOf(def.parameters);
  const args = Object.keys(call.arguments).map((key) =>
    checkArg(key, call.arguments[key], properties),
  );
  const missing = requiredOf(def.parameters).filter((key) => !hasOwn(call.arguments, key));
  return {
    name: call.name,
    matched: true,
    args,
    missing,
    valid: missing.length === 0 && args.every((a) => a.verdict === "ok"),
  };
}

/**
 * The session tally — `7 calls · 5 valid · 2 malformed`.
 *
 * Prose replies are not calls and are not counted here: a model that answers
 * a tool-shaped prompt in words is a finding of a different kind, and folding
 * it into "malformed" would overstate the failure rate the tally exists to
 * measure.
 */
export function tally(verdicts: CallVerdict[]): Tally {
  const valid = verdicts.filter((v) => v.valid).length;
  return { calls: verdicts.length, valid, malformed: verdicts.length - valid };
}
