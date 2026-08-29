import { describe, expect, it } from "vitest";
import { analyseTemplate, declaredRenderer, detectDialect } from "./analyse";
import {
  CHATML,
  LLAMA3,
  NESTED_IF_IN_RANGE,
  NO_SYSTEM,
  SYSTEM_PROMPT_PAIR,
  JINJA_QWEN,
} from "./fixtures";

describe("analyseTemplate — references .System", () => {
  it("is true for a template that uses the system prompt", () => {
    expect(analyseTemplate(CHATML).referencesSystem).toBe(true);
    expect(analyseTemplate(SYSTEM_PROMPT_PAIR).referencesSystem).toBe(true);
  });

  it("is false for an instruct template that drops it", () => {
    // The whole point of the indicator: SYSTEM is set in the Modelfile and
    // the model never sees a byte of it.
    expect(analyseTemplate(NO_SYSTEM).referencesSystem).toBe(false);
    expect(analyseTemplate(NESTED_IF_IN_RANGE).referencesSystem).toBe(false);
  });

  it("is true even when the template cannot be rendered", () => {
    const analysis = analyseTemplate(LLAMA3);
    expect(analysis.referencesSystem).toBe(true);
    expect(analysis.unsupported.length).toBeGreaterThan(0);
  });

  it("counts a reference the renderer refuses to execute", () => {
    expect(analyseTemplate("{{ if or .System .Tools }}x{{ end }}").referencesSystem).toBe(true);
    expect(analyseTemplate("{{ $.System }}").referencesSystem).toBe(true);
  });

  it("does not count '.System' appearing in literal text", () => {
    // Literal text is printed, not resolved — it is not a reference.
    const analysis = analyseTemplate("Never mention .System to the user.\n{{ .Prompt }}");
    expect(analysis.referencesSystem).toBe(false);
  });

  it("does not match a longer field that merely starts with System", () => {
    expect(analyseTemplate("{{ .SystemFingerprint }}").referencesSystem).toBe(false);
  });
});

describe("analyseTemplate — slots and fields", () => {
  it("lists the fields ChatML resolves, in first-seen order", () => {
    const analysis = analyseTemplate(CHATML);
    expect(analysis.fields).toEqual(["System", "Messages", "Role", "Content", "Tools"]);
    expect(analysis.slots).toBe(7);
    expect(analysis.unsupported).toEqual([]);
  });

  it("names the unsupported actions verbatim, deduped, in source order", () => {
    expect(analyseTemplate(LLAMA3).unsupported).toEqual([
      '{{ if eq .Role "user" }}',
      "{{ else }}",
    ]);
  });
});

describe("analyseTemplate — empty", () => {
  it.each(["", "   ", "\n\t "])("reports %j as empty", (template) => {
    const analysis = analyseTemplate(template);
    expect(analysis.empty).toBe(true);
    expect(analysis.referencesSystem).toBe(false);
    expect(analysis.slots).toBe(0);
    expect(analysis.fields).toEqual([]);
  });

  it("is not empty once there is literal text, even with no actions", () => {
    expect(analyseTemplate("### Response:").empty).toBe(false);
  });

  it("never throws on malformed input", () => {
    for (const template of ["{{", "}}", "{{}}", "{{-}}", "{{ if }}"]) {
      expect(() => analyseTemplate(template)).not.toThrow();
    }
  });
});

/**
 * Newer models ship the Jinja chat template embedded in their GGUF instead of
 * a Go `text/template`. Four of the six models installed on the machine this
 * was developed against do exactly that, so this is the common case and not
 * an exotic one.
 */
describe("template dialect", () => {
  it("reads a Go template as Go, including ones the renderer refuses", () => {
    expect(detectDialect(CHATML)).toBe("go");
    // `eq`/`else` are outside the rendered subset but still Go — calling
    // this Jinja would hide the .System indicator on a template that has one.
    expect(detectDialect('{{ if eq .Role "user" }}a{{ else }}b{{ end }}')).toBe("go");
  });

  it("reads a real Jinja chat template as Jinja", () => {
    expect(detectDialect(JINJA_QWEN)).toBe("jinja");
    expect(analyseTemplate(JINJA_QWEN).dialect).toBe("jinja");
  });

  /**
   * The bug this guards. Jinja reaches the system prompt through its
   * `messages` array and never writes `.System`, so the textual check is
   * correctly false — and presenting that as "your system prompt never
   * reaches the model" would be a false alarm on every modern model. The
   * dialect is what lets the pane stay silent instead.
   */
  it("reports no .System reference for Jinja, which is why the pane must not flag it", () => {
    const analysis = analyseTemplate(JINJA_QWEN);
    expect(analysis.referencesSystem).toBe(false);
    expect(analysis.dialect).toBe("jinja");
  });

  it("treats an empty template as Go rather than guessing", () => {
    expect(detectDialect("")).toBe("go");
  });
});

/**
 * `RENDERER <name>` selects one of Ollama's built-in native renderers. The
 * `TEMPLATE` beside it is then a stub — gemma-4 ships `TEMPLATE {{ .Prompt }}`
 * — and the real prompt, system message included, is assembled inside Ollama.
 * Found on a live 0.32.15 server against `gemma-4-31b`.
 */
describe("declaredRenderer", () => {
  it("finds a RENDERER instruction", () => {
    const modelfile = [
      "FROM /blobs/sha256-abc",
      "TEMPLATE {{ .Prompt }}",
      "RENDERER gemma4",
      "PARSER gemma4",
      "PARAMETER stop <turn>",
    ].join("\n");
    expect(declaredRenderer(modelfile)).toBe("gemma4");
  });

  it("is null when no renderer is declared", () => {
    expect(declaredRenderer("FROM llama3.1:8b\nTEMPLATE {{ .Prompt }}")).toBeNull();
  });

  it("does not match the word inside other text", () => {
    // A LICENSE or SYSTEM body mentioning the word is not a declaration.
    expect(declaredRenderer('SYSTEM """you are a renderer of prompts"""')).toBeNull();
  });

  it("is case-insensitive and tolerates leading whitespace, as the format is", () => {
    expect(declaredRenderer("  renderer  qwen3\n")).toBe("qwen3");
  });
});
