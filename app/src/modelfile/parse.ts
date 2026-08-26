/**
 * Modelfile parser — the kernel of the M3 editor (SPEC §5.4, §6).
 *
 * A Modelfile is parsed into an ordered list of segments. Managed
 * instructions — FROM / SYSTEM / PARAMETER / TEMPLATE, the ones the form
 * edits — carry a parsed value *and* their exact source text; everything
 * else (comments, blank lines, LICENSE, ADAPTER, MESSAGE, and anything
 * malformed) becomes a passthrough segment holding the verbatim lines.
 *
 * Two laws follow from SPEC §5.4's sync contract:
 *
 *   1. Round-trip: `serializeModelfile(parseModelfile(text)) === text`,
 *      byte for byte, for any input. Every segment keeps its exact source
 *      bytes (line terminators included), so serialization is pure
 *      concatenation — the parse can never lose information.
 *   2. Nothing is dropped: an unrecognized or malformed line becomes
 *      passthrough, never an exception and never a silent discard. This is
 *      the cardinal rule.
 */

/** Fields shared by every managed (form-editable) instruction segment. */
interface ManagedBase {
  /** Exact source text of this instruction, line terminators included. */
  raw: string;
  /** First source line of the instruction (0-based, inclusive). */
  startLine: number;
  /** Last source line of the instruction (0-based, inclusive). */
  endLine: number;
}

export interface FromSegment extends ManagedBase {
  kind: "from";
  value: string;
}

export interface SystemSegment extends ManagedBase {
  kind: "system";
  value: string;
}

export interface ParameterSegment extends ManagedBase {
  kind: "parameter";
  /** Key as written (comparisons are case-insensitive, case is kept). */
  key: string;
  value: string;
}

export interface TemplateSegment extends ManagedBase {
  kind: "template";
  value: string;
}

/**
 * Verbatim lines the editor does not manage: comments, blank runs,
 * LICENSE / ADAPTER / MESSAGE instructions, and malformed input.
 */
export interface PassthroughSegment {
  kind: "passthrough";
  /** Verbatim source text, line terminators included. */
  text: string;
  startLine: number;
  endLine: number;
}

export type ModelfileSegment =
  | FromSegment
  | SystemSegment
  | ParameterSegment
  | TemplateSegment
  | PassthroughSegment;

export interface ModelfileDoc {
  segments: ModelfileSegment[];
}

/** Instructions the form manages; everything else is passthrough. */
const MANAGED_KEYWORDS = new Set(["from", "system", "template"]);

/**
 * The full instruction set we recognize. LICENSE / ADAPTER / MESSAGE are
 * real grammar (so their triple-quoted bodies must be consumed as one
 * span — a line reading `FROM …` inside a LICENSE block is prose, not an
 * instruction) but the form doesn't edit them, so they stay passthrough.
 */
const KNOWN_KEYWORDS = new Set([
  ...MANAGED_KEYWORDS,
  "parameter",
  "license",
  "adapter",
  "message",
]);

/** Line content without its terminator (handles LF and CRLF). */
function stripEol(line: string): string {
  return line.replace(/\r?\n$/, "");
}

/**
 * Strip one surrounding pair of double quotes from a single-line value
 * (`SYSTEM "You are terse."`). A `"""` opener is not a quoted value and
 * is handled by the block scanner instead.
 */
function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    value.startsWith('"') &&
    !value.startsWith('"""') &&
    value.endsWith('"')
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseModelfile(rawText: string): ModelfileDoc {
  const segments: ModelfileSegment[] = [];
  if (rawText === "") {
    return { segments };
  }

  // Split keeping terminators, so raw slices concatenate back to the
  // exact input — including a missing trailing newline.
  const lines = rawText.split(/(?<=\n)/);

  // Consecutive passthrough lines coalesce into one segment.
  let passStart = -1;
  const passLines: string[] = [];
  const pushPass = (index: number): void => {
    if (passStart === -1) passStart = index;
    passLines.push(lines[index]);
  };
  const flushPass = (): void => {
    if (passStart === -1) return;
    segments.push({
      kind: "passthrough",
      text: passLines.join(""),
      startLine: passStart,
      endLine: passStart + passLines.length - 1,
    });
    passStart = -1;
    passLines.length = 0;
  };

  let i = 0;
  while (i < lines.length) {
    const content = stripEol(lines[i]);
    const head = /^\s*([A-Za-z_]+)(?:\s+(.*))?$/.exec(content);
    const keyword = head === null ? null : head[1].toLowerCase();
    if (head === null || keyword === null || !KNOWN_KEYWORDS.has(keyword)) {
      // Comment, blank, or something we don't understand: keep verbatim.
      pushPass(i);
      i += 1;
      continue;
    }
    const rest = (head[2] ?? "").replace(/\s+$/, "");

    if (keyword === "parameter") {
      const pm = /^(\S+)\s+(\S[\s\S]*)$/.exec(rest);
      if (pm === null) {
        // PARAMETER without a key + value is malformed → passthrough.
        pushPass(i);
        i += 1;
        continue;
      }
      flushPass();
      segments.push({
        kind: "parameter",
        key: pm[1],
        value: stripQuotes(pm[2]),
        raw: lines[i],
        startLine: i,
        endLine: i,
      });
      i += 1;
      continue;
    }

    // Remaining keywords take the rest of the line as their value,
    // possibly triple-quoted across multiple lines.
    let value: string;
    let consumed = 1;
    if (rest.startsWith('"""')) {
      const afterOpen = rest.slice(3);
      const closeInline = afterOpen.indexOf('"""');
      if (closeInline !== -1) {
        value = afterOpen.slice(0, closeInline);
      } else {
        const parts = [afterOpen];
        let closed = false;
        let j = i + 1;
        for (; j < lines.length; j += 1) {
          const lineContent = stripEol(lines[j]);
          const at = lineContent.indexOf('"""');
          if (at !== -1) {
            parts.push(lineContent.slice(0, at));
            closed = true;
            break;
          }
          parts.push(lineContent);
        }
        if (!closed) {
          // Unterminated """ block: conservatively keep the rest of the
          // file verbatim rather than guess at instruction boundaries
          // inside what was meant to be quoted prose.
          for (let k = i; k < lines.length; k += 1) pushPass(k);
          break;
        }
        value = parts.join("\n");
        // The line break after an opening """ and the one before a
        // closing """ on its own line are delimiters, not content. This
        // mirrors how serialize.ts renders block values, so our own
        // output re-parses to the exact same value.
        if (parts[0] === "" && value.startsWith("\n")) {
          value = value.slice(1);
        }
        if (parts[parts.length - 1] === "" && value.endsWith("\n")) {
          value = value.slice(0, -1);
        }
        consumed = j - i + 1;
      }
    } else {
      value = stripQuotes(rest);
    }

    const managed =
      MANAGED_KEYWORDS.has(keyword) &&
      // FROM with nothing after it (or SYSTEM/TEMPLATE with no value at
      // all) is malformed — keep it verbatim instead of inventing an
      // empty value. `SYSTEM ""` (explicitly quoted empty) stays managed.
      !(rest === "" || (keyword === "from" && value.trim() === ""));

    if (!managed) {
      // LICENSE / ADAPTER / MESSAGE, or a malformed managed instruction:
      // the whole span (including a triple-quoted body) is passthrough.
      for (let k = i; k < i + consumed; k += 1) pushPass(k);
      i += consumed;
      continue;
    }

    flushPass();
    const base = {
      raw: lines.slice(i, i + consumed).join(""),
      startLine: i,
      endLine: i + consumed - 1,
    };
    if (keyword === "from") {
      segments.push({ kind: "from", value, ...base });
    } else if (keyword === "system") {
      segments.push({ kind: "system", value, ...base });
    } else {
      segments.push({ kind: "template", value, ...base });
    }
    i += consumed;
  }

  flushPass();
  return { segments };
}

/** FROM value, or null when the file has none. First occurrence wins. */
export function from(doc: ModelfileDoc): string | null {
  for (const s of doc.segments) {
    if (s.kind === "from") return s.value;
  }
  return null;
}

/** SYSTEM value, or null when the file has none. First occurrence wins. */
export function system(doc: ModelfileDoc): string | null {
  for (const s of doc.segments) {
    if (s.kind === "system") return s.value;
  }
  return null;
}

/** TEMPLATE value, or null when the file has none. First occurrence wins. */
export function template(doc: ModelfileDoc): string | null {
  for (const s of doc.segments) {
    if (s.kind === "template") return s.value;
  }
  return null;
}

/**
 * All PARAMETER values, keyed by lowercased name. `stop` is repeatable
 * and always comes back as an array (SPEC §6); for any other repeated
 * key the last occurrence wins, matching how Ollama applies them.
 */
export function parameters(doc: ModelfileDoc): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const s of doc.segments) {
    if (s.kind !== "parameter") continue;
    const key = s.key.toLowerCase();
    if (key === "stop") {
      const existing = out[key];
      if (Array.isArray(existing)) {
        existing.push(s.value);
      } else {
        out[key] = [s.value];
      }
    } else {
      out[key] = s.value;
    }
  }
  return out;
}
