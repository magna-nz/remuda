/**
 * Modelfile serializer and targeted updaters (SPEC §5.4).
 *
 * The cardinal rule: an update regenerates ONLY its own instruction's
 * lines, in place. Every passthrough segment and every untouched
 * instruction survives byte-for-byte, in order. Serialization is pure
 * concatenation of each segment's exact source bytes, which is what makes
 * `serializeModelfile(parseModelfile(text)) === text` hold for any input.
 *
 * Updaters return a NEW doc. Internally they splice the regenerated raw
 * text into the segment list and re-parse the result — re-parsing keeps
 * segment line ranges and parsed values consistent by construction, and
 * every renderer below emits text that parses back to the value it was
 * given, so the round trip through an update is exact too.
 */

import {
  parseModelfile,
  type ModelfileDoc,
  type ModelfileSegment,
} from "./parse";

/** A segment's exact source bytes. */
function segmentRaw(segment: ModelfileSegment): string {
  return segment.kind === "passthrough" ? segment.text : segment.raw;
}

export function serializeModelfile(doc: ModelfileDoc): string {
  let out = "";
  for (const segment of doc.segments) {
    out += segmentRaw(segment);
  }
  return out;
}

function renderFrom(value: string): string {
  return `FROM ${value}\n`;
}

/**
 * Render a prose-valued instruction (SYSTEM / TEMPLATE).
 *
 * Plain single-line form when the value survives it verbatim; otherwise a
 * `"""` block with the delimiters on their own lines — the parser strips
 * exactly the delimiter line breaks, so any value (empty, leading quote,
 * surrounding whitespace, embedded quotes and blank lines) round-trips.
 * The one thing the grammar cannot express is a multi-line value that
 * itself contains `"""`; we refuse loudly rather than emit text that
 * would re-parse to something else (never silently discard).
 */
function renderProse(keyword: string, value: string): string {
  const needsBlock =
    value.includes("\n") ||
    value.startsWith('"') ||
    value !== value.trim() ||
    value === "";
  if (!needsBlock) {
    return `${keyword} ${value}\n`;
  }
  if (value.includes('"""')) {
    throw new Error(
      `${keyword} value contains \`"""\`, which the Modelfile grammar ` +
        "cannot represent inside a triple-quoted block; edit the raw " +
        "Modelfile instead.",
    );
  }
  return `${keyword} """\n${value}\n"""\n`;
}

function renderParameter(key: string, value: string): string {
  // A PARAMETER is a single-line instruction; a value with a line break
  // would re-parse as something else entirely. Refuse loudly rather than
  // silently mangle — mirrors renderProse's `"""` refusal.
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `PARAMETER ${key} value contains a line break, which the Modelfile ` +
        "grammar cannot represent in a parameter; remove it or edit the " +
        "raw Modelfile instead.",
    );
  }
  const quoted =
    value === "" || /\s/.test(value) || value.startsWith('"')
      ? `"${value}"`
      : value;
  return `PARAMETER ${key} ${quoted}\n`;
}

/**
 * Where a not-yet-present instruction goes, per the conventional order:
 * FROM first, SYSTEM after FROM, PARAMETERs after SYSTEM, TEMPLATE last.
 * Positions are relative to existing instructions only, so passthrough
 * content (header comments, LICENSE, …) is never displaced.
 */
function insertIndexFor(
  doc: ModelfileDoc,
  kind: "from" | "system" | "parameter" | "template",
): number {
  const segs = doc.segments;
  const firstOf = (...kinds: string[]): number =>
    segs.findIndex((s) => kinds.includes(s.kind));
  const lastOf = (...kinds: string[]): number => {
    for (let i = segs.length - 1; i >= 0; i -= 1) {
      if (kinds.includes(segs[i].kind)) return i;
    }
    return -1;
  };
  switch (kind) {
    case "from": {
      const first = firstOf("system", "parameter", "template");
      return first === -1 ? segs.length : first;
    }
    case "system": {
      const afterFrom = lastOf("from");
      if (afterFrom !== -1) return afterFrom + 1;
      const before = firstOf("parameter", "template");
      return before === -1 ? segs.length : before;
    }
    case "parameter": {
      const anchor = lastOf("parameter") !== -1
        ? lastOf("parameter")
        : lastOf("system") !== -1
          ? lastOf("system")
          : lastOf("from");
      return anchor === -1 ? segs.length : anchor + 1;
    }
    case "template":
      return segs.length;
  }
}

/**
 * Insert `rendered` at `index` in the raw list, adding a separating
 * newline only when the preceding text ends mid-line (a file with no
 * trailing newline). The newline is prepended to the NEW text so every
 * existing segment keeps its exact bytes.
 */
function insertRaw(raws: string[], index: number, rendered: string): void {
  let text = rendered;
  if (index > 0 && !raws[index - 1].endsWith("\n")) {
    text = `\n${text}`;
  }
  raws.splice(index, 0, text);
}

/**
 * Replace the segment at `index` with `rendered`, preserving the file's
 * trailing-newline state: if the old instruction was the file's final
 * line and had no terminator, the regenerated one doesn't grow one.
 */
function replaceRaw(raws: string[], index: number, rendered: string): void {
  const keepNoEol = !raws[index].endsWith("\n") && index === raws.length - 1;
  raws[index] = keepNoEol ? rendered.replace(/\n$/, "") : rendered;
}

function upsert(
  doc: ModelfileDoc,
  kind: "from" | "system" | "template",
  rendered: string,
): ModelfileDoc {
  const raws = doc.segments.map(segmentRaw);
  const existing = doc.segments.findIndex((s) => s.kind === kind);
  if (existing !== -1) {
    replaceRaw(raws, existing, rendered);
  } else {
    insertRaw(raws, insertIndexFor(doc, kind), rendered);
  }
  return parseModelfile(raws.join(""));
}

/** Set (or append) the FROM instruction. Returns a new doc. */
export function setFrom(doc: ModelfileDoc, value: string): ModelfileDoc {
  return upsert(doc, "from", renderFrom(value));
}

/** Set (or append) the SYSTEM instruction. Returns a new doc. */
export function setSystem(doc: ModelfileDoc, value: string): ModelfileDoc {
  return upsert(doc, "system", renderProse("SYSTEM", value));
}

/** Set (or append) the TEMPLATE instruction. Returns a new doc. */
export function setTemplate(doc: ModelfileDoc, value: string): ModelfileDoc {
  return upsert(doc, "template", renderProse("TEMPLATE", value));
}

/**
 * Set one PARAMETER (matched case-insensitively). `null` removes it.
 * A repeated key collapses onto the first occurrence's position — for
 * the repeatable `stop`, prefer {@link setStops}. Returns a new doc.
 */
export function setParameter(
  doc: ModelfileDoc,
  key: string,
  value: string | number | boolean | null,
): ModelfileDoc {
  const lower = key.toLowerCase();
  const matches: number[] = [];
  doc.segments.forEach((s, i) => {
    if (s.kind === "parameter" && s.key.toLowerCase() === lower) {
      matches.push(i);
    }
  });
  const raws = doc.segments.map(segmentRaw);
  if (value === null) {
    if (matches.length === 0) return doc;
    for (const m of [...matches].reverse()) raws.splice(m, 1);
    return parseModelfile(raws.join(""));
  }
  const rendered = renderParameter(key, String(value));
  if (matches.length === 0) {
    insertRaw(raws, insertIndexFor(doc, "parameter"), rendered);
    return parseModelfile(raws.join(""));
  }
  for (const m of matches.slice(1).reverse()) raws.splice(m, 1);
  replaceRaw(raws, matches[0], rendered);
  return parseModelfile(raws.join(""));
}

/**
 * Replace the full set of `PARAMETER stop` lines. The new lines occupy
 * the first existing stop's position (or the conventional parameter spot
 * when there were none); an empty array removes them all. Returns a new
 * doc.
 */
export function setStops(doc: ModelfileDoc, stops: string[]): ModelfileDoc {
  const matches: number[] = [];
  doc.segments.forEach((s, i) => {
    if (s.kind === "parameter" && s.key.toLowerCase() === "stop") {
      matches.push(i);
    }
  });
  const raws = doc.segments.map(segmentRaw);
  const block = stops.map((s) => renderParameter("stop", s)).join("");
  if (matches.length === 0) {
    if (stops.length === 0) return doc;
    insertRaw(raws, insertIndexFor(doc, "parameter"), block);
    return parseModelfile(raws.join(""));
  }
  for (const m of matches.slice(1).reverse()) raws.splice(m, 1);
  if (stops.length === 0) {
    raws.splice(matches[0], 1);
  } else {
    replaceRaw(raws, matches[0], block);
  }
  return parseModelfile(raws.join(""));
}
