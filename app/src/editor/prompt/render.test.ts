import { describe, expect, it } from "vitest";
import { renderTemplate, scanTemplate, type RenderResult } from "./render";
import {
  CHATML,
  LLAMA3,
  NESTED_IF_IN_RANGE,
  NO_SYSTEM,
  SYSTEM_PROMPT_PAIR,
} from "./fixtures";

/** Narrow to the success arm, failing loudly (with the reason) when it isn't. */
function rendered(result: RenderResult): string {
  if (!result.ok) throw new Error(`expected a render, got: ${result.message}`);
  return result.text;
}

const TWO_TURNS = [
  { role: "user", content: "Hi" },
  { role: "assistant", content: "Hello" },
];

describe("renderTemplate — plain templates", () => {
  it("substitutes .System and .Prompt", () => {
    const result = renderTemplate(SYSTEM_PROMPT_PAIR, {
      system: "You are terse.",
      prompt: "Rewrite this loop.",
    });
    expect(rendered(result)).toBe("You are terse.\nRewrite this loop.");
  });

  it("marks substituted values as fills and template bytes as literals", () => {
    const result = renderTemplate(SYSTEM_PROMPT_PAIR, { system: "S", prompt: "P" });
    if (!result.ok) throw new Error(result.message);
    expect(result.segments).toEqual([
      { kind: "fill", field: "System", text: "S" },
      { kind: "literal", text: "\n" },
      { kind: "fill", field: "Prompt", text: "P" },
    ]);
    // The pane concatenates segments to draw the pane and uses `text` for
    // Copy; they must never disagree.
    expect(result.segments.map((s) => s.text).join("")).toBe(result.text);
  });

  it("renders a template with no actions verbatim", () => {
    expect(rendered(renderTemplate("### Response:\n", {}))).toBe("### Response:\n");
  });

  it("renders the instruct template that never mentions .System", () => {
    const result = renderTemplate(NO_SYSTEM, {
      system: "You are terse.",
      prompt: "Rewrite this loop.",
    });
    // The system prompt is simply gone — the bug this pane exists to show.
    expect(rendered(result)).toBe("[INST] Rewrite this loop. [/INST]");
  });
});

describe("renderTemplate — {{ if .System }}", () => {
  it("includes the branch when a system prompt is set", () => {
    const result = renderTemplate(CHATML, {
      system: "You are terse.",
      messages: TWO_TURNS,
    });
    expect(rendered(result)).toBe(
      "<|im_start|>system\nYou are terse.<|im_end|>\n" +
        "\n<|im_start|>user\nHi<|im_end|>\n" +
        "\n<|im_start|>assistant\nHello<|im_end|>\n" +
        "\n<|im_start|>assistant\n",
    );
  });

  it("drops the branch entirely when there is no system prompt", () => {
    const result = renderTemplate(CHATML, {
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(rendered(result)).toBe(
      "\n<|im_start|>user\nHi<|im_end|>\n\n<|im_start|>assistant\n",
    );
    expect(rendered(result)).not.toContain("system");
  });

  it("treats an empty string as false, exactly as Go's zero value does", () => {
    const template = "{{ if .System }}SYS{{ end }}|{{ if .Tools }}TOOLS{{ end }}";
    expect(rendered(renderTemplate(template, { system: "", tools: "" }))).toBe("|");
    expect(rendered(renderTemplate(template, { system: "x", tools: "y" }))).toBe(
      "SYS|TOOLS",
    );
  });

  it("tests .Messages for emptiness without printing it", () => {
    const template = "{{ if .Messages }}has turns{{ end }}";
    expect(rendered(renderTemplate(template, { messages: [] }))).toBe("");
    expect(rendered(renderTemplate(template, { messages: TWO_TURNS }))).toBe("has turns");
  });
});

describe("renderTemplate — {{ range .Messages }}", () => {
  it("repeats the body per message with .Role and .Content", () => {
    const template = "{{ range .Messages }}[{{ .Role }}] {{ .Content }}\n{{ end }}";
    expect(rendered(renderTemplate(template, { messages: TWO_TURNS }))).toBe(
      "[user] Hi\n[assistant] Hello\n",
    );
  });

  it("emits nothing for an empty transcript, and still finds the {{ end }}", () => {
    const template = "A{{ range .Messages }}[{{ .Role }}]{{ end }}B";
    expect(rendered(renderTemplate(template, { messages: [] }))).toBe("AB");
  });

  it("handles an {{ if }} nested inside the range body", () => {
    const result = renderTemplate(NESTED_IF_IN_RANGE, {
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "" },
      ],
    });
    expect(rendered(result)).toBe("<|user|>\nHi\n<|assistant|>\n");
  });

  it("marks every substituted role and content", () => {
    const result = renderTemplate("{{ range .Messages }}{{ .Role }}:{{ .Content }};{{ end }}", {
      messages: TWO_TURNS,
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.segments.filter((s) => s.kind === "fill")).toEqual([
      { kind: "fill", field: "Role", text: "user" },
      { kind: "fill", field: "Content", text: "Hi" },
      { kind: "fill", field: "Role", text: "assistant" },
      { kind: "fill", field: "Content", text: "Hello" },
    ]);
  });
});

describe("renderTemplate — whitespace trim markers", () => {
  it("trims the preceding newline for {{- and the following one for -}}", () => {
    expect(rendered(renderTemplate("a\n  {{- .Prompt }}", { prompt: "P" }))).toBe("aP");
    expect(rendered(renderTemplate("{{ .Prompt -}}\n  b", { prompt: "P" }))).toBe("Pb");
  });

  it("leaves a bare - alone: {{-3}} is a number, not a trim marker", () => {
    // ...and a number is outside the subset, so it must be refused rather
    // than silently read as a trim.
    const result = renderTemplate("a\n{{-3}}", {});
    expect(result.ok).toBe(false);
  });
});

describe("renderTemplate — anything outside the subset does not render", () => {
  it("refuses llama3's template and names the action that stopped it", () => {
    const result = renderTemplate(LLAMA3, { system: "S", messages: TWO_TURNS });
    if (result.ok) throw new Error("llama3 uses `eq` and `else`; it must not render");
    expect(result.kind).toBe("unsupported");
    expect(result.action).toBe('{{ if eq .Role "user" }}');
    expect(result.message).toContain('{{ if eq .Role "user" }}');
  });

  it.each([
    ["else", "{{ if .System }}a{{ else }}b{{ end }}"],
    ["with", "{{ with .System }}{{ . }}{{ end }}"],
    ["a pipeline", "{{ .System | upper }}"],
    ["a builtin", "{{ if or .System .Tools }}x{{ end }}"],
    ["a variable", "{{ $x := .System }}"],
    ["a comment", "{{/* nothing to see */}}"],
    ["an unknown field", "{{ .Response }}"],
    ["range over a non-list", "{{ range .Tools }}x{{ end }}"],
    ["a nested template", '{{ template "sys" . }}'],
    ["an unterminated action", "hello {{ .Sys"],
  ])("refuses %s rather than guessing", (_name, template) => {
    const result = renderTemplate(template, { system: "S", tools: "T" });
    if (result.ok) throw new Error(`expected a refusal, rendered: ${result.text}`);
    expect(result.kind).toBe("unsupported");
    expect(result.action).not.toBe("");
  });

  it("refuses a field used outside the scope that has it", () => {
    const outside = renderTemplate("{{ .Role }}", { messages: TWO_TURNS });
    if (outside.ok) throw new Error("`.Role` has no meaning outside a range");
    expect(outside.message).toContain("only available inside");

    const inside = renderTemplate("{{ range .Messages }}{{ .System }}{{ end }}", {
      system: "S",
      messages: TWO_TURNS,
    });
    if (inside.ok) throw new Error("`.System` has no meaning inside a range");
    expect(inside.message).toContain("not available inside");
  });

  it("refuses to print .Messages, whose Go formatting it cannot reproduce", () => {
    const result = renderTemplate("{{ .Messages }}", { messages: TWO_TURNS });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("{{ range }}");
  });

  it("refuses an unsupported action even in a branch that never fires", () => {
    // Go parses the whole template before executing any of it. Rendering
    // this today and failing once a system prompt is set would be the worst
    // of both.
    const result = renderTemplate("{{ if .System }}{{ .System | upper }}{{ end }}", {
      system: "",
    });
    expect(result.ok).toBe(false);
  });

  it("reports mismatched if/range/end as a structure failure, not a render", () => {
    const noEnd = renderTemplate("{{ if .System }}x", { system: "S" });
    if (noEnd.ok) throw new Error("expected a refusal");
    expect(noEnd.kind).toBe("structure");
    expect(noEnd.message).toContain("{{ end }}");

    const strayEnd = renderTemplate("x{{ end }}", {});
    if (strayEnd.ok) throw new Error("expected a refusal");
    expect(strayEnd.kind).toBe("structure");

    const rangeNoEnd = renderTemplate("{{ range .Messages }}{{ .Role }}", {
      messages: TWO_TURNS,
    });
    if (rangeNoEnd.ok) throw new Error("expected a refusal");
    expect(rangeNoEnd.kind).toBe("structure");
  });
});

describe("renderTemplate — totality", () => {
  it("renders an empty template as empty", () => {
    const result = renderTemplate("", {});
    expect(rendered(result)).toBe("");
    if (!result.ok) throw new Error(result.message);
    expect(result.segments).toEqual([]);
  });

  it("renders a whitespace-only template verbatim", () => {
    expect(rendered(renderTemplate("  \n\t\n", { system: "S" }))).toBe("  \n\t\n");
  });

  it.each([
    "",
    "   ",
    "{{",
    "}}",
    "{{}}",
    "{{ }}",
    "{{{{}}}}",
    "{{-}}",
    "{{ end }}{{ end }}",
    "{{ range .Messages }}",
    "{{ if }}{{ end }}",
    " {{ .System }} ",
    "{{ .System }}".repeat(200),
  ])("never throws on %j", (template) => {
    expect(() => renderTemplate(template, {})).not.toThrow();
    expect(() => scanTemplate(template)).not.toThrow();
  });

  it("defaults every absent field to Go's zero value", () => {
    expect(rendered(renderTemplate("[{{ .System }}][{{ .Prompt }}][{{ .Tools }}]", {}))).toBe(
      "[][][]",
    );
  });
});

describe("scanTemplate", () => {
  it("keeps each action's verbatim source, trim markers included", () => {
    const tokens = scanTemplate("a{{- if .System }}b{{ end }}");
    expect(tokens.map((t) => (t.kind === "action" ? t.source : t.text))).toEqual([
      "a",
      "{{- if .System }}",
      "b",
      "{{ end }}",
    ]);
    expect(tokens.filter((t) => t.kind === "action").map((t) => t.action)).toEqual([
      { kind: "if", field: "System" },
      { kind: "end" },
    ]);
  });
});
