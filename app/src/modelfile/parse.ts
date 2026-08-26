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
 * A well-formed LICENSE / ADAPTER / MESSAGE instruction found inside a
 * passthrough run. The editor still doesn't manage its bytes — the text
 * stays verbatim in the segment — but the structured /api/create payload
 * must carry these (createRequest.ts), so the parse notes what it saw
 * rather than losing it at the wire (the cardinal rule).
 */
export interface PassthroughInstruction {
  keyword: "license" | "adapter" | "message";
  /** MESSAGE only: the role preceding the content. */
  role?: "system" | "user" | "assistant";
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
  /**
   * LICENSE / ADAPTER / MESSAGE instructions within this run, in source
   * order. Absent when the run is only comments, blanks, or malformed
   * input.
   */
  instructions?: PassthroughInstruction[];
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

  // Consecutive passthrough lines coalesce into one segment; well-formed
  // LICENSE / ADAPTER / MESSAGE instructions inside the run are noted in
  // source order so createRequest.ts can carry them to /api/create.
  let passStart = -1;
  const passLines: string[] = [];
  const passInstructions: PassthroughInstruction[] = [];
  const pushPass = (index: number): void => {
    if (passStart === -1) passStart = index;
    passLines.push(lines[index]);
  };
  const flushPass = (): void => {
    if (passStart === -1) return;
    const segment: PassthroughSegment = {
      kind: "passthrough",
      text: passLines.join(""),
      startLine: passStart,
      endLine: passStart + passLines.length - 1,
    };
    if (passInstructions.length > 0) {
      segment.instructions = [...passInstructions];
    }
    segments.push(segment);
    passStart = -1;
    passLines.length = 0;
    passInstructions.length = 0;
  };

  /**
   * Resolve an instruction value starting at `text` on line `lineIndex`,
   * consuming further lines when it opens a `"""` block. Returns null when
   * the block never closes.
   */
  const resolveValue = (
    text: string,
    lineIndex: number,
  ): { value: string; consumed: number } | null => {
    if (!text.startsWith('"""')) {
      return { value: stripQuotes(text), consumed: 1 };
    }
    const afterOpen = text.slice(3);
    const closeInline = afterOpen.indexOf('"""');
    if (closeInline !== -1) {
      return { value: afterOpen.slice(0, closeInline), consumed: 1 };
    }
    const parts = [afterOpen];
    for (let j = lineIndex + 1; j < lines.length; j += 1) {
      const lineContent = stripEol(lines[j]);
      const at = lineContent.indexOf('"""');
      if (at === -1) {
        parts.push(lineContent);
        continue;
      }
      parts.push(lineContent.slice(0, at));
      let value = parts.join("\n");
      // The line break after an opening """ and the one before a closing
      // """ on its own line are delimiters, not content. This mirrors how
      // serialize.ts renders block values, so our own output re-parses to
      // the exact same value.
      if (parts[0] === "" && value.startsWith("\n")) {
        value = value.slice(1);
      }
      if (parts[parts.length - 1] === "" && value.endsWith("\n")) {
        value = value.slice(0, -1);
      }
      return { value, consumed: j - lineIndex + 1 };
    }
    return null;
  };

  /**
   * Unterminated """ block: conservatively keep the rest of the file
   * verbatim rather than guess at instruction boundaries inside what was
   * meant to be quoted prose.
   */
  const passRemainder = (start: number): void => {
    for (let k = start; k < lines.length; k += 1) pushPass(k);
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

    if (keyword === "message") {
      // MESSAGE <role> <content>: a role comes before the (possibly
      // triple-quoted) content. An unknown role is malformed →
      // passthrough, unannotated.
      const mm = /^(system|user|assistant)\s+(\S[\s\S]*)$/i.exec(rest);
      if (mm === null) {
        pushPass(i);
        i += 1;
        continue;
      }
      const resolved = resolveValue(mm[2], i);
      if (resolved === null) {
        passRemainder(i);
        break;
      }
      for (let k = i; k < i + resolved.consumed; k += 1) pushPass(k);
      passInstructions.push({
        keyword: "message",
        role: mm[1].toLowerCase() as "system" | "user" | "assistant",
        value: resolved.value,
      });
      i += resolved.consumed;
      continue;
    }

    // Remaining keywords take the rest of the line as their value,
    // possibly triple-quoted across multiple lines.
    const resolved = resolveValue(rest, i);
    if (resolved === null) {
      passRemainder(i);
      break;
    }
    const { value, consumed } = resolved;

    const managed =
      MANAGED_KEYWORDS.has(keyword) &&
      // FROM with nothing after it (or SYSTEM/TEMPLATE with no value at
      // all) is malformed — keep it verbatim instead of inventing an
      // empty value. `SYSTEM ""` (explicitly quoted empty) stays managed.
      !(rest === "" || (keyword === "from" && value.trim() === ""));

    if (!managed) {
      // LICENSE / ADAPTER, or a malformed managed instruction: the whole
      // span (including a triple-quoted body) is passthrough. Well-formed
      // LICENSE / ADAPTER additionally get noted for the create payload.
      for (let k = i; k < i + consumed; k += 1) pushPass(k);
      if ((keyword === "license" || keyword === "adapter") && rest !== "") {
        passInstructions.push({ keyword, value });
      }
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
