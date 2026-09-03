/**
 * The Prompt pane end to end (SPEC-round-two.md R3): the segment appears,
 * the render substitutes the draft's SYSTEM, the footer's `.System` check
 * flips, and a template outside the subset falls back to the raw text
 * instead of a guess.
 */
import "../../chat/test/localStorage";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { EditorView } from "../EditorView";
import { TopNav } from "../../ui/TopNav";
import { RemudaProvider } from "../../ui/state";
import { FakeClient, makeModel } from "../../ui/test/FakeClient";

const SYSTEM = `SYSTEM """You are terse. Answer in one line."""`;

/** ChatML — inside the renderer's subset, and it uses the system prompt. */
const WITH_SYSTEM = `FROM llama3.1:8b

${SYSTEM}

TEMPLATE """{{ if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}<|im_start|>assistant
"""
`;

/** Mistral's instruct template: real, common, and it drops SYSTEM silently. */
const WITHOUT_SYSTEM = `FROM llama3.1:8b

${SYSTEM}

TEMPLATE """[INST] {{ .Prompt }} [/INST]"""
`;

/**
 * A Jinja chat template, the kind newer models embed in their GGUF. Four of
 * the six models installed on the development machine ship one of these, so
 * this is the common case. Jinja reaches the system prompt through its
 * `messages` array and never writes `.System` — the pane must therefore stay
 * silent on the indicator rather than claim the prompt is being dropped.
 */
const JINJA = `FROM llama3.1:8b

${SYSTEM}

TEMPLATE """{%- set ns = namespace(value=0) %}
{%- for m in messages %}
{{- m.content }}
{%- endfor %}"""
`;

/** Llama 3's, which uses `eq` — outside the subset, so it must not render. */
const UNSUPPORTED = `FROM llama3.1:8b

${SYSTEM}

TEMPLATE """{{ range .Messages }}{{ if eq .Role "user" }}{{ .Content }}{{ end }}{{ end }}"""
`;

async function openPrompt(modelfile: string) {
  const client = new FakeClient({
    models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
    modelfile,
  });
  render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <TopNav />
      <EditorView />
    </RemudaProvider>,
  );
  fireEvent.click(await screen.findByLabelText("Edit llama3.1:8b's Modelfile"));
  await screen.findByLabelText("Raw Modelfile");
  fireEvent.click(screen.getByRole("button", { name: "Prompt" }));
}

describe("PromptView", () => {
  it("renders the template with the draft's SYSTEM substituted", async () => {
    await openPrompt(WITH_SYSTEM);

    const rendered = screen.getByLabelText("Rendered prompt");
    // No trailing newline: `modelfile/parse.ts` drops the one before a
    // `"""` terminator, so the draft's TEMPLATE genuinely ends at
    // "assistant" — the pane shows what the Modelfile holds, not a tidied
    // version of it.
    expect(rendered.textContent).toBe(
      "<|im_start|>system\nYou are terse. Answer in one line.<|im_end|>\n<|im_start|>assistant",
    );
    // Substituted text is marked so the pane can tell it from the template's
    // own bytes.
    expect(rendered.querySelector(".slotfill")?.textContent).toBe(
      "You are terse. Answer in one line.",
    );
    // Anchored on the ✓: the pane's own help strip also mentions
    // "references .System" in its third step, so a bare /references/ regex
    // now matches two elements.
    expect(screen.getByText(/✓ references/).textContent).toContain("✓ references");
  });

  it("goes red when the template cannot see the system prompt", async () => {
    await openPrompt(WITHOUT_SYSTEM);

    const check = screen.getByText(/does not reference/);
    expect(check.textContent).toContain("never reaches the model");
    expect(check.className).toContain("bad");
    // The system prompt really is absent from what the model receives.
    expect(screen.getByLabelText("Rendered prompt").textContent).toBe("[INST]  [/INST]");
  });

  it("refuses a template outside the subset and shows the raw template", async () => {
    await openPrompt(UNSUPPORTED);

    expect(screen.queryByLabelText("Rendered prompt")).toBeNull();
    const notice = screen.getByText(/Unsupported template action/);
    expect(notice.textContent).toContain('{{ if eq .Role "user" }}');
    expect(notice.textContent).toContain("documented subset");
    // Both columns now show the template — the left one marked, the right
    // one as the fallback.
    expect(screen.getAllByLabelText("Template")).toHaveLength(2);
    // Nothing rendered means nothing to copy.
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
  });

  it("leaves the other segments alone and comes back to them", async () => {
    await openPrompt(WITH_SYSTEM);
    expect(screen.queryByLabelText("Raw Modelfile")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(screen.getByLabelText("Raw Modelfile")).toBeInTheDocument();
    expect(screen.queryByLabelText("Rendered prompt")).toBeNull();

    // Raw is the store's pane by now, so re-selecting it changes nothing
    // there; only the segment's own reset pulls the user off Prompt.
    fireEvent.click(screen.getByRole("button", { name: "Prompt" }));
    expect(screen.getByLabelText("Rendered prompt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(screen.getByLabelText("Raw Modelfile")).toBeInTheDocument();
  });
});

describe("PromptView — Jinja templates", () => {
  it("does not claim the system prompt is dropped", async () => {
    await openPrompt(JINJA);

    // The red flag is the whole point of the pane, so a false one is worse
    // than none: it would send someone rewriting a template that is fine.
    expect(screen.queryByText(/does not reference/)).not.toBeInTheDocument();
    expect(screen.getByText(/does not apply/)).toBeInTheDocument();
  });

  it("says it is a Jinja template rather than reporting an unsupported action", async () => {
    await openPrompt(JINJA);

    // Named in both places it matters: the footer, in place of the
    // indicator, and the right-hand pane, in place of a render.
    expect(screen.getAllByText(/Jinja/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/unsupported action/i)).not.toBeInTheDocument();
  });
});

describe("PromptView — layer 2 pane help (R5)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the toggle and shows the strip open on first sight", async () => {
    await openPrompt(WITH_SYSTEM);

    const toggle = screen.getByRole("button", { name: "About the rendered prompt" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("region", { name: "About Prompt. The exact text the model receives" }),
    ).toBeInTheDocument();
  });

  it("dismissing the strip persists the close", async () => {
    await openPrompt(WITH_SYSTEM);

    fireEvent.click(screen.getByRole("button", { name: /^Close help for Prompt/ }));
    expect(
      screen.queryByRole("region", { name: "About Prompt. The exact text the model receives" }),
    ).not.toBeInTheDocument();
    expect(window.localStorage.getItem("remuda.help.v1")).toContain("prompt");
  });
});
