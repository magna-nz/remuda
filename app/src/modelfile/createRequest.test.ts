import { describe, expect, it } from "vitest";
import { parseModelfile } from "./parse";
import { toCreateRequest } from "./createRequest";
import { DECORATED, ONLY_COMMENTS, TYPICAL } from "./fixtures";

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
    expect(toCreateRequest(parseModelfile(DECORATED)).rawModelfile).toBe(DECORATED);
  });

  it("throws a descriptive error when there is no FROM", () => {
    expect(() => toCreateRequest(parseModelfile(ONLY_COMMENTS))).toThrow(
      /no FROM instruction/,
    );
  });
});
