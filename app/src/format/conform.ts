/**
 * Does the reply fit the schema it was decoded under? (docs/SPEC-round-two.md
 * R2, docs/mockup-proposals-2.html §02, the `.conform` card.)
 *
 * Pure — no React, no storage, no client. The verdict is **derived on every
 * call and never stored**, exactly as T3's tool-call card does it: edit the
 * schema and every reply already on screen is re-judged, which is the loop
 * this feature exists for.
 *
 * **This module does not validate anything itself.** tools/validate.ts is
 * the JSON-Schema subset Remuda ships, it is tested, and its per-argument
 * notes ("wrong type · expected number, got string", "not in enum [...]")
 * are the exact strings the tool-call card renders. Judging a reply body is
 * the same question asked of a different object, so the body is handed to
 * `validateCall` as one call's arguments and the schema as that call's
 * `parameters`. A second validator here would drift from the first within a
 * release, and the two cards would then disagree about the same schema.
 *
 * The one thing it adds is **truncation**. Under `format` the model cannot
 * emit invalid JSON — the decoder will not let it — so a reply that does not
 * parse was *cut off*, almost always because `num_predict` ran out. Reporting
 * that as a parse error would send the user looking for a bug in the model's
 * output when the fix is one number in the run controls. `scanJson` below is
 * what tells the two apart: a prefix of valid JSON has unclosed brackets or
 * an unterminated string, a genuinely malformed document usually does not.
 */
import { jsonTypeOf, validateCall, type ArgCheck } from "../tools/validate";
import { propertyNames, propertySchema, requiredNames } from "./format";

/** Row colour, mirroring the mockup's `.fb` modifiers. */
export type ConformTone = "ok" | "no" | "extra" | "miss";

export interface ConformRow {
  /** Property name, or `(root)` for a reply that isn't an object. */
  key: string;
  /** The value as it reads in the row — JSON, or a phrase when there is none. */
  value: string;
  /** The uppercase badge: a declared type when ok, the failure when not. */
  badge: string;
  tone: ConformTone;
  /** validate.ts's own note, verbatim; null when the row is fine. */
  detail: string | null;
}

export type ConformStatus =
  /** Parsed, and every judged property held. */
  | "conforms"
  /** Parsed, but at least one property is wrong, unknown or missing. */
  | "fails"
  /** Did not parse, and the text ends mid-value: the reply was cut off. */
  | "truncated"
  /** Did not parse, and not from truncation — reachable only without `format`. */
  | "invalid";

export interface Conformance {
  status: ConformStatus;
  /** The card's headline: "Conforms", "Cut off, not valid JSON", … */
  headline: string;
  /** The right-hand detail: property counts, or the cause of the cut. */
  summary: string;
  rows: ConformRow[];
}

/* ── Truncation detection ───────────────────────────────────────────────── */

export interface Scan {
  /**
   * Every string, array and object that opened also closed. False means the
   * text is a *prefix* — the model was still writing when it stopped.
   */
  complete: boolean;
  /** The text ran out inside a string literal ("truncated mid-string"). */
  endedInString: boolean;
  /** Top-level object keys, in the order they were emitted. */
  keys: string[];
}

/**
 * Structural scan of a JSON document, tolerant of it ending early.
 *
 * Not a parser and not a validator: it tracks string state and bracket depth
 * and nothing else, because the only question asked of it is "did this stop
 * in the middle". `JSON.parse` has already answered whether the text is
 * valid by the time this runs.
 */
export function scanJson(text: string): Scan {
  const stack: string[] = [];
  const keys: string[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  // The most recent completed string literal, which in valid JSON is the key
  // whenever the next non-space character is a colon.
  let lastString = "";

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
        lastString = text.slice(stringStart, i);
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      escaped = false;
      stringStart = i + 1;
    } else if (c === "{" || c === "[") {
      stack.push(c);
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ":" && stack.length === 1 && stack[0] === "{") {
      keys.push(lastString);
    }
  }

  return {
    complete: !inString && stack.length === 0 && text.trim() !== "",
    endedInString: inString,
    keys,
  };
}

/* ── Display helpers ────────────────────────────────────────────────────── */

const VALUE_MAX = 96;

/** How a value reads in a row: JSON, elided when it would push the row wide. */
export function valueText(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length <= VALUE_MAX ? text : `${text.slice(0, VALUE_MAX - 1)}…`;
}

/**
 * The badge on a row that held: the type the *schema* declares, not the type
 * the value happens to be. "integer[]" and "enum" are the mockup's, and both
 * say something `jsonTypeOf` cannot — that the array's members were
 * constrained, and that the string came from a closed list.
 */
export function typeBadge(schema: Record<string, unknown> | null): string {
  if (schema === null) return "ok";
  if (Array.isArray(schema.enum)) return "enum";
  const type = schema.type;
  if (type === "array") {
    const items = schema.items;
    if (typeof items === "object" && items !== null && !Array.isArray(items)) {
      const itemType = (items as Record<string, unknown>).type;
      if (typeof itemType === "string") return `${itemType}[]`;
    }
    return "array";
  }
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    const names = type.filter((t): t is string => typeof t === "string");
    if (names.length > 0) return names.join(" | ");
  }
  return "ok";
}

/** validate.ts's four verdicts → this card's badge and colour. */
function rowFor(check: ArgCheck, schema: Record<string, unknown> | null): ConformRow {
  if (check.verdict === "ok") {
    return {
      key: check.key,
      value: valueText(check.value),
      badge: typeBadge(propertySchema(schema, check.key)),
      tone: "ok",
      detail: null,
    };
  }
  return {
    key: check.key,
    value: valueText(check.value),
    // "unknown key" is the model volunteering something the schema never
    // asked for — a difference, not a breakage, so it reads amber like the
    // mockup's `.fb.extra` rather than red.
    badge: check.verdict === "unknown key" ? "extra" : check.verdict,
    tone: check.verdict === "unknown key" ? "extra" : "no",
    detail: check.detail,
  };
}

/* ── The verdict ────────────────────────────────────────────────────────── */

/**
 * validate.ts speaks in tool calls, so the reply is handed to it as one: the
 * body becomes the call's `arguments` and the schema becomes that tool's
 * `parameters`. Nothing here is sent anywhere — this name never leaves the
 * process — and the alternative, a second validator, is the thing R2
 * explicitly forbids.
 */
const AS_CALL = "response";

function judgeObject(
  body: Record<string, unknown>,
  schema: Record<string, unknown>,
): Conformance {
  const verdict = validateCall(
    { name: AS_CALL, arguments: body },
    [{ name: AS_CALL, parameters: schema }],
  );
  const rows: ConformRow[] = verdict.args.map((check) => rowFor(check, schema));
  for (const key of verdict.missing) {
    rows.push({
      key,
      value: "—",
      badge: "missing",
      tone: "miss",
      detail: "required by the schema, absent from the reply",
    });
  }

  const declared = propertyNames(schema).length;
  const required = requiredNames(schema).length;
  const present = required - verdict.missing.length;
  const counts = [
    `${verdict.args.length} of ${declared} ${declared === 1 ? "property" : "properties"}`,
  ];
  if (required > 0) {
    counts.push(`${present} of ${required} required present`);
  }

  return {
    status: verdict.valid ? "conforms" : "fails",
    headline: verdict.valid ? "Conforms" : "Doesn’t conform",
    summary: counts.join(" · "),
    rows,
  };
}

/**
 * A reply that isn't an object — a schema of `type: "array"`, or a bare
 * string. Routed through validate.ts too, as a one-property object, so the
 * type and enum rules are the same ones the object path uses instead of a
 * second copy written here.
 */
function judgeRoot(body: unknown, schema: Record<string, unknown>): Conformance {
  const verdict = validateCall(
    { name: AS_CALL, arguments: { value: body } },
    [{ name: AS_CALL, parameters: { type: "object", properties: { value: schema } } }],
  );
  const check = verdict.args[0];
  const row = rowFor(check, null);
  return {
    status: check.verdict === "ok" ? "conforms" : "fails",
    headline: check.verdict === "ok" ? "Conforms" : "Doesn’t conform",
    summary: `the reply is a ${jsonTypeOf(body)}`,
    rows: [
      {
        ...row,
        key: "(root)",
        badge: check.verdict === "ok" ? typeBadge(schema) : row.badge,
      },
    ],
  };
}

/**
 * Rows for a reply that never finished, from the keys it managed to emit.
 *
 * Deliberately not a salvage attempt: nothing here is parsed, so no value is
 * reported as good. The last key it wrote is where the cut landed, the ones
 * before it made it out, and the ones it never reached are named — which is
 * the whole diagnosis, and it is about `num_predict`, not the model.
 */
function truncatedRows(schema: Record<string, unknown> | null, scan: Scan): ConformRow[] {
  const declared = propertyNames(schema);
  if (declared.length === 0) return [];
  const lastEmitted = scan.keys[scan.keys.length - 1];
  return declared.map((key) => {
    if (!scan.keys.includes(key)) {
      return {
        key,
        value: "never emitted",
        badge: "missing",
        tone: "miss" as const,
        detail: "generation stopped before this property",
      };
    }
    if (key === lastEmitted) {
      return {
        key,
        value: scan.endedInString ? "truncated mid-string" : "cut off here",
        badge: "incomplete",
        tone: "no" as const,
        detail: "the reply ends inside this value",
      };
    }
    return {
      key,
      value: "emitted before the cut",
      badge: "written",
      tone: "ok" as const,
      detail: null,
    };
  });
}

/**
 * Judge one reply.
 *
 * `schema` is null in `json` mode — Ollama guaranteed valid JSON and nothing
 * about its shape, so the card says that and judges no fields.
 * `numPredict` is the chat's own override, used only to name the limit that
 * was hit; absent, the card still names `num_predict` as the thing to raise.
 */
export function conformance(
  text: string,
  schema: Record<string, unknown> | null,
  numPredict?: number,
): Conformance {
  const trimmed = text.trim();
  let body: unknown;
  try {
    body = JSON.parse(trimmed);
  } catch (error) {
    const scan = scanJson(trimmed);
    if (!scan.complete) {
      return {
        status: "truncated",
        headline: "Cut off, not valid JSON",
        summary:
          numPredict === undefined
            ? "num_predict ran out before the reply closed"
            : `num_predict ${numPredict} reached`,
        rows: truncatedRows(schema, scan),
      };
    }
    // Unreachable while `format` is in force — the decoder cannot emit this
    // — so say what happened rather than blaming a limit that wasn't hit.
    return {
      status: "invalid",
      headline: "Not valid JSON",
      summary: error instanceof Error ? error.message : "parse failed",
      rows: [],
    };
  }

  if (schema === null) {
    return {
      status: "conforms",
      headline: "Valid JSON",
      summary: "json mode, the shape was not constrained",
      rows: [],
    };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return judgeRoot(body, schema);
  }
  return judgeObject(body as Record<string, unknown>, schema);
}
