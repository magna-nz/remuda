import { describe, expect, it } from "vitest";
import {
  from,
  parameters,
  parseModelfile,
  system,
  template,
  type ModelfileDoc,
} from "./parse";
import {
  serializeModelfile,
  setFrom,
  setParameter,
  setStops,
  setSystem,
  setTemplate,
} from "./serialize";
import {
  DECORATED,
  NO_TRAILING_NEWLINE,
  ONLY_COMMENTS,
  TYPICAL,
} from "./fixtures";

/**
 * Split `text` around a managed segment's exact source bytes, so a test
 * can assert everything outside the edited lines survives byte-for-byte.
 */
function splitAround(text: string, doc: ModelfileDoc, kind: string): [string, string] {
  const seg = doc.segments.find((s) => s.kind === kind);
  if (seg === undefined || seg.kind === "passthrough") {
    throw new Error(`fixture has no ${kind} segment`);
  }
  const at = text.indexOf(seg.raw);
  expect(at).toBeGreaterThanOrEqual(0);
  return [text.slice(0, at), text.slice(at + seg.raw.length)];
}

describe("update in place (SPEC §5.4)", () => {
  it("regenerates only the SYSTEM lines in a decorated file", () => {
    const doc = parseModelfile(DECORATED);
    const [before, after] = splitAround(DECORATED, doc, "system");
    const updated = setSystem(doc, "You are new.\nBe kind.");
    expect(serializeModelfile(updated)).toBe(
      `${before}SYSTEM """\nYou are new.\nBe kind.\n"""\n${after}`,
    );
    expect(system(updated)).toBe("You are new.\nBe kind.");
    // The original doc is untouched.
    expect(serializeModelfile(doc)).toBe(DECORATED);
  });

  it("regenerates only the FROM line", () => {
    const doc = parseModelfile(DECORATED);
    const [before, after] = splitAround(DECORATED, doc, "from");
    const updated = setFrom(doc, "mistral:7b");
    expect(serializeModelfile(updated)).toBe(`${before}FROM mistral:7b\n${after}`);
    expect(from(updated)).toBe("mistral:7b");
  });

  it("updates one PARAMETER without touching its neighbours", () => {
    const text = "FROM x\nPARAMETER temperature 0.7\nPARAMETER top_p 0.9\nPARAMETER num_ctx 4096\n";
    const updated = setParameter(parseModelfile(text), "top_p", 0.95);
    expect(serializeModelfile(updated)).toBe(
      "FROM x\nPARAMETER temperature 0.7\nPARAMETER top_p 0.95\nPARAMETER num_ctx 4096\n",
    );
  });

  it("keeps parameter order stable across add and remove", () => {
    let doc = parseModelfile("FROM x\nPARAMETER temperature 0.7\nPARAMETER num_ctx 4096\n");
    doc = setParameter(doc, "top_p", 0.9); // added after the last parameter
    expect(serializeModelfile(doc)).toBe(
      "FROM x\nPARAMETER temperature 0.7\nPARAMETER num_ctx 4096\nPARAMETER top_p 0.9\n",
    );
    doc = setParameter(doc, "num_ctx", null); // removed in place
    expect(serializeModelfile(doc)).toBe(
      "FROM x\nPARAMETER temperature 0.7\nPARAMETER top_p 0.9\n",
    );
  });

  it("removing an absent parameter changes nothing", () => {
    const doc = parseModelfile(TYPICAL);
    expect(serializeModelfile(setParameter(doc, "top_k", null))).toBe(TYPICAL);
  });

  it("replaces the stop set at the first stop's position", () => {
    const doc = parseModelfile(TYPICAL);
    const updated = setStops(doc, ["</s>", "USER:", "###"]);
    const text = serializeModelfile(updated);
    expect(text).toContain(
      "PARAMETER num_ctx 4096\nPARAMETER stop </s>\nPARAMETER stop USER:\nPARAMETER stop ###\n",
    );
    expect(parameters(updated).stop).toEqual(["</s>", "USER:", "###"]);
    // Everything outside the stop lines is untouched.
    expect(text.replace(/^PARAMETER stop .*\n/gm, "")).toBe(
      TYPICAL.replace(/^PARAMETER stop .*\n/gm, ""),
    );
  });

  it("setStops([]) removes every stop line and nothing else", () => {
    const updated = setStops(parseModelfile(TYPICAL), []);
    expect(serializeModelfile(updated)).toBe(
      TYPICAL.replace(/^PARAMETER stop .*\n/gm, ""),
    );
  });

  it("adds stops after the last parameter when none exist", () => {
    const doc = parseModelfile("FROM x\nPARAMETER temperature 0.7\n\n# end\n");
    const updated = setStops(doc, ["</s>"]);
    expect(serializeModelfile(updated)).toBe(
      "FROM x\nPARAMETER temperature 0.7\nPARAMETER stop </s>\n\n# end\n",
    );
  });

  it("quotes parameter values containing whitespace", () => {
    const doc = setStops(parseModelfile("FROM x\n"), ["USER :"]);
    expect(serializeModelfile(doc)).toBe('FROM x\nPARAMETER stop "USER :"\n');
    expect(parameters(doc).stop).toEqual(["USER :"]); // and it re-parses
  });
});

describe("appending missing instructions", () => {
  it("builds up a file in conventional order without disturbing comments", () => {
    let doc = parseModelfile(ONLY_COMMENTS);
    doc = setFrom(doc, "llama3.2:3b");
    doc = setTemplate(doc, "{{ .Prompt }}");
    doc = setSystem(doc, "Be brief."); // lands between FROM and TEMPLATE
    doc = setParameter(doc, "temperature", 0.2); // after SYSTEM
    expect(serializeModelfile(doc)).toBe(
      `${ONLY_COMMENTS}FROM llama3.2:3b\nSYSTEM Be brief.\nPARAMETER temperature 0.2\nTEMPLATE {{ .Prompt }}\n`,
    );
  });

  it("starts a file from nothing", () => {
    const doc = setFrom(parseModelfile(""), "llama3");
    expect(serializeModelfile(doc)).toBe("FROM llama3\n");
  });

  it("appends to a file with no trailing newline on its own line", () => {
    const doc = parseModelfile(NO_TRAILING_NEWLINE);
    const updated = setTemplate(doc, "{{ .Prompt }}");
    expect(serializeModelfile(updated)).toBe(
      `${NO_TRAILING_NEWLINE}\nTEMPLATE {{ .Prompt }}\n`,
    );
  });
});

describe("trailing-newline preservation", () => {
  it("updating the final, unterminated line does not grow a newline", () => {
    const doc = parseModelfile(NO_TRAILING_NEWLINE);
    const updated = setParameter(doc, "temperature", 2);
    expect(serializeModelfile(updated)).toBe("FROM qwen2.5:7b\nPARAMETER temperature 2");
  });
});

describe("value fidelity through an update round trip", () => {
  const reread = (doc: ModelfileDoc): ModelfileDoc =>
    parseModelfile(serializeModelfile(doc));

  it.each([
    ["multi-line", "line one\n\nline three"],
    ["leading quote", '"quoted start'],
    ["surrounding whitespace", "  padded  "],
    ["empty", ""],
    ["trailing newline", "keeps this\n"],
    ["inline triple quote on one line", 'say """ ok'],
  ])("SYSTEM %s value survives serialize→parse", (_name, value) => {
    const doc = setSystem(parseModelfile("FROM x\n"), value);
    expect(system(reread(doc))).toBe(value);
  });

  it("TEMPLATE block values survive serialize→parse", () => {
    const value = "{{ .System }}\n{{ .Prompt }}";
    const doc = setTemplate(parseModelfile("FROM x\n"), value);
    expect(template(reread(doc))).toBe(value);
  });

  it('refuses a multi-line value containing `"""` instead of mangling it', () => {
    const doc = parseModelfile("FROM x\n");
    expect(() => setSystem(doc, 'has\n"""\ninside')).toThrow(/cannot represent/);
  });

  it("refuses parameter values containing a line break instead of mangling them", () => {
    const doc = parseModelfile("FROM x\n");
    expect(() => setStops(doc, ["a\nb"])).toThrow(/line break/);
    expect(() => setParameter(doc, "stop", "a\nb")).toThrow(/line break/);
    expect(() => setParameter(doc, "temperature", "0.7\nSYSTEM pwned")).toThrow(
      /line break/,
    );
  });

  it("refuses parameter values that would not survive a round-trip (quote runs)", () => {
    // A stop of `"""` used to render as PARAMETER stop """"" — five quotes —
    // which re-parsed to a DIFFERENT value and compounded on every save.
    // The renderer now self-checks render→parse fidelity and refuses.
    const doc = parseModelfile("FROM x\n");
    expect(() => setStops(doc, ['"""'])).toThrow(/cannot be represented/);
    expect(() => setParameter(doc, "stop", '""')).toThrow(/cannot be represented/);
    // Values that DO survive keep working, quotes included.
    const ok = setStops(doc, ['</s>', "two words"]);
    expect(serializeModelfile(ok)).toContain('PARAMETER stop </s>');
    expect(serializeModelfile(ok)).toContain('PARAMETER stop "two words"');
  });
});
