import { describe, expect, it } from "vitest";
import {
  from,
  parameters,
  parseModelfile,
  system,
  template,
} from "./parse";
import { serializeModelfile } from "./serialize";
import {
  DECORATED,
  EMPTY,
  JUNK,
  ODD_SPACING,
  ROUND_TRIP_FIXTURES,
  TRIPLE_SYSTEM,
  TYPICAL,
  UNTERMINATED,
} from "./fixtures";

describe("round-trip law", () => {
  // Property-style: parse→serialize is byte identity for every fixture.
  it.each(ROUND_TRIP_FIXTURES)("%s", (_name, text) => {
    expect(serializeModelfile(parseModelfile(text))).toBe(text);
  });
});

describe("parseModelfile", () => {
  it("parses a typical generated file", () => {
    const doc = parseModelfile(TYPICAL);
    expect(from(doc)).toBe("llama3.1:8b");
    expect(system(doc)).toBe(
      "You are a terse assistant.\nAnswer in one sentence.",
    );
    expect(parameters(doc)).toEqual({
      temperature: "0.7",
      num_ctx: "4096",
      stop: ["<|start_header_id|>", "<|end_header_id|>"],
    });
    expect(template(doc)).toBe("{{ .System }}\n{{ .Prompt }}");
  });

  it("records exact source line ranges", () => {
    const doc = parseModelfile(TYPICAL);
    const sys = doc.segments.find((s) => s.kind === "system");
    expect(sys).toMatchObject({ startLine: 3, endLine: 6 });
    const fromSeg = doc.segments.find((s) => s.kind === "from");
    expect(fromSeg).toMatchObject({ startLine: 1, endLine: 1 });
  });

  it("keeps LICENSE / ADAPTER / MESSAGE and comments as passthrough", () => {
    const doc = parseModelfile(DECORATED);
    const passText = doc.segments
      .filter((s) => s.kind === "passthrough")
      .map((s) => s.text)
      .join("");
    expect(passText).toContain("ADAPTER ./lora.safetensors");
    expect(passText).toContain("MESSAGE user Hello there");
    expect(passText).toContain("MIT License");
    expect(passText).toContain("# trailing comment");
  });

  it("does not treat instruction-like prose inside a LICENSE block as an instruction", () => {
    const doc = parseModelfile(DECORATED);
    // Only the real FROM parses; the "FROM inside license…" line is prose.
    expect(doc.segments.filter((s) => s.kind === "from")).toHaveLength(1);
    expect(from(doc)).toBe("llama3.1:8b");
  });

  it("keeps embedded quotes and blank lines in a triple-quoted SYSTEM", () => {
    const doc = parseModelfile(TRIPLE_SYSTEM);
    expect(system(doc)).toBe(
      'Say "hello" first.\n\nThen say "goodbye".\n',
    );
  });

  it("parses a single-line SYSTEM, trimming surrounding whitespace", () => {
    const doc = parseModelfile(ODD_SPACING);
    expect(system(doc)).toBe("plain single line system");
    expect(from(doc)).toBe("llama3.2:3b");
    expect(parameters(doc)).toEqual({ temperature: "0.9" });
  });

  it("strips one pair of surrounding double quotes from single-line values", () => {
    const doc = parseModelfile('SYSTEM "You are  spaced "\nPARAMETER stop "USER:"\n');
    expect(system(doc)).toBe("You are  spaced ");
    expect(parameters(doc)).toEqual({ stop: ["USER:"] });
  });

  it("matches instructions case-insensitively but keeps value case", () => {
    const doc = parseModelfile("from LLaMa3\nsystem Be Bold\nparameter temperature 0.5\n");
    expect(from(doc)).toBe("LLaMa3");
    expect(system(doc)).toBe("Be Bold");
    expect(parameters(doc)).toEqual({ temperature: "0.5" });
  });

  it("turns malformed and unknown lines into passthrough, never throwing", () => {
    const doc = parseModelfile(JUNK);
    expect(doc.segments).toHaveLength(1);
    expect(doc.segments[0].kind).toBe("passthrough");
    expect(from(doc)).toBeNull();
    expect(system(doc)).toBeNull();
  });

  it("keeps an unterminated triple-quoted block verbatim as passthrough", () => {
    const doc = parseModelfile(UNTERMINATED);
    expect(from(doc)).toBe("llama3");
    // The broken SYSTEM never becomes a managed segment…
    expect(system(doc)).toBeNull();
    // …but every byte of it survives.
    expect(serializeModelfile(doc)).toBe(UNTERMINATED);
  });

  it("parses an empty file to an empty doc", () => {
    expect(parseModelfile(EMPTY).segments).toEqual([]);
  });

  it("coalesces consecutive unmanaged lines into one passthrough segment", () => {
    const doc = parseModelfile("# a\n# b\n\nFROM x\n");
    expect(doc.segments.map((s) => s.kind)).toEqual(["passthrough", "from"]);
    expect(doc.segments[0]).toMatchObject({ startLine: 0, endLine: 2 });
  });
});
