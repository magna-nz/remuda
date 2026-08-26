/**
 * Project a parsed Modelfile onto the /api/create payload (SPEC §5.4, §7).
 *
 * Both request forms derive from the same doc: the structured fields for
 * current servers, and `rawModelfile` — the byte-exact serialization —
 * for the legacy fallback (SPEC §9 version skew).
 */

import type { CreateRequest } from "../api/types";
import { from, parameters, system, template, type ModelfileDoc } from "./parse";
import { serializeModelfile } from "./serialize";

/** Strict numeric literal — we only coerce what is unambiguously a number. */
const NUMBER_RE = /^-?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/;

/**
 * PARAMETER values are stored as written; the API wants typed values
 * (`temperature 0.7` is a float, `penalize_newline true` a boolean).
 * Anything else stays a string.
 */
function coerce(value: string): string | number | boolean {
  if (NUMBER_RE.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

export function toCreateRequest(doc: ModelfileDoc): CreateRequest {
  const base = from(doc);
  if (base === null) {
    throw new Error(
      "Modelfile has no FROM instruction — a base model is required " +
        "before it can be created (add `FROM <model>`).",
    );
  }
  const request: CreateRequest = {
    from: base,
    rawModelfile: serializeModelfile(doc),
  };
  const sys = system(doc);
  if (sys !== null) request.system = sys;
  const tmpl = template(doc);
  if (tmpl !== null) request.template = tmpl;

  const params = parameters(doc);
  const keys = Object.keys(params);
  if (keys.length > 0) {
    const out: NonNullable<CreateRequest["parameters"]> = {};
    for (const key of keys) {
      const value = params[key];
      // stop sequences are always strings — never coerced, even "0".
      out[key] = Array.isArray(value) ? value : coerce(value);
    }
    request.parameters = out;
  }
  return request;
}
