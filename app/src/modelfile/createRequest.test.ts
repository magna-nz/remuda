import { describe, expect, it } from "vitest";
import { parseModelfile } from "./parse";
import { toCreateRequest } from "./createRequest";
import {
  DECORATED,
  DECORATED_NO_ADAPTER,
  EXTRAS,
  ONLY_COMMENTS,
  TYPICAL,
} from "./fixtures";

describe("toCreateRequest", () => {
  it("projects a typical file, parsing numbers and collecting stops", () => {
    const request = toCreateRequest(parseModelfile(TYPICAL));
    expect(request.from).toBe("llama3.1:8b");
    expect(request.system).toBe(
      "You are a terse assistant.\nAnswer in one sentence.",
    );
    expect(request.template).toBe("{{ .System }}\n{{ .Prompt }}");
    expect(request.parameters).toEqual({
      temperature: 0.7, // number, not "0.7"
      num_ctx: 4096,
      stop: ["<|start_header_id|>", "<|end_header_id|>"],
    });
    expect(request.rawModelfile).toBe(TYPICAL);
  });

  it("coerces booleans and leaves non-numeric strings alone", () => {
    const request = toCreateRequest(
      parseModelfile(
        "FROM x\nPARAMETER penalize_newline true\nPARAMETER mirostat 0\nPARAMETER seed -1\nPARAMETER stop 42\n",
      ),
    );
    expect(request.parameters).toEqual({
      penalize_newline: true,
      mirostat: 0,
      seed: -1,
      stop: ["42"], // stop sequences stay strings, even numeric-looking
    });
  });

  it("omits absent fields rather than sending empty ones", () => {
    const request = toCreateRequest(parseModelfile("FROM llama3\n"));
    expect(request).toEqual({ from: "llama3", rawModelfile: "FROM llama3\n" });
    expect(request.system).toBeUndefined();
    expect(request.template).toBeUndefined();
    expect(request.parameters).toBeUndefined();
  });

  it("carries the byte-exact raw Modelfile for the legacy fallback", () => {
    expect(toCreateRequest(parseModelfile(DECORATED_NO_ADAPTER)).rawModelfile).toBe(
      DECORATED_NO_ADAPTER,
    );
  });

  it("carries a triple-quoted LICENSE block and MESSAGEs from a decorated file", () => {
    const request = toCreateRequest(parseModelfile(DECORATED_NO_ADAPTER));
    expect(request.license).toBe(
      "MIT License\nFROM inside license is prose, not an instruction\n\nCopyright (c) 2026",
    );
    expect(request.messages).toEqual([
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi! How can I help?" },
    ]);
  });

  it("carries a single-line LICENSE", () => {
    const request = toCreateRequest(
      parseModelfile("FROM x\nLICENSE Apache-2.0\n"),
    );
    expect(request.license).toBe("Apache-2.0");
  });

  it("keeps MESSAGE order and roles, including triple-quoted bodies", () => {
    const request = toCreateRequest(
      parseModelfile(
        'FROM x\nMESSAGE system Be nice\nMESSAGE user """\nHi\nthere\n"""\nMESSAGE assistant Yo\n',
      ),
    );
    expect(request.messages).toEqual([
      { role: "system", content: "Be nice" },
      { role: "user", content: "Hi\nthere" },
      { role: "assistant", content: "Yo" },
    ]);
  });

  it("refuses ADAPTER rather than silently dropping the LoRA", () => {
    expect(() => toCreateRequest(parseModelfile(DECORATED))).toThrow(
      /ADAPTER isn't supported/,
    );
    expect(() => toCreateRequest(parseModelfile(EXTRAS))).toThrow(
      /ollama CLI/,
    );
  });

  it("throws a descriptive error when there is no FROM", () => {
    expect(() => toCreateRequest(parseModelfile(ONLY_COMMENTS))).toThrow(
      /no FROM instruction/,
    );
  });
});
