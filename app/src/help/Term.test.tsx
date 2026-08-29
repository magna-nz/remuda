import "../chat/test/localStorage";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Term } from "./Term";
import { GLOSSARY, lookupTerm } from "./glossary";

function trigger(name = "num_ctx"): HTMLElement {
  return screen.getByRole("button", { name });
}

function popover(): HTMLElement | null {
  return screen.queryByRole("tooltip");
}

describe("Term", () => {
  /**
   * The requirement the component exists to satisfy: hover-only help is
   * unreachable from a keyboard and invisible on a touch screen, so each of
   * the three routes is asserted on its own.
   */
  it("opens on keyboard focus", () => {
    render(<Term name="num_ctx" />);
    expect(popover()).not.toBeInTheDocument();

    fireEvent.focus(trigger());

    expect(popover()).toBeInTheDocument();
    expect(popover()).toHaveTextContent(/How much text the model can hold at once/);
  });

  it("opens on click", () => {
    render(<Term name="num_ctx" />);
    expect(popover()).not.toBeInTheDocument();

    fireEvent.click(trigger());

    expect(popover()).toBeInTheDocument();
  });

  /**
   * The sequence a real mouse produces, which `fireEvent.click` on its own
   * does not: the pointer arrives, the button takes focus, *then* the click
   * lands. Firing only the click hid a bug where the first click closed the
   * popover it had just opened.
   */
  it("stays open through the full hover → focus → click sequence a mouse fires", () => {
    render(<Term name="num_ctx" />);

    fireEvent.mouseEnter(trigger());
    fireEvent.focus(trigger());
    fireEvent.click(trigger());

    expect(popover()).toBeInTheDocument();

    // And it is pinned by that click, so the pointer leaving does not close it.
    fireEvent.mouseLeave(trigger());
    expect(popover()).toBeInTheDocument();
  });

  it("closes on the next click after a real mouse open", () => {
    render(<Term name="num_ctx" />);

    fireEvent.mouseEnter(trigger());
    fireEvent.focus(trigger());
    fireEvent.click(trigger());
    fireEvent.click(trigger());

    expect(popover()).not.toBeInTheDocument();
  });

  it("opens on hover", () => {
    render(<Term name="num_ctx" />);

    fireEvent.mouseEnter(trigger());

    expect(popover()).toBeInTheDocument();
  });

  it("closes again when the pointer leaves, if the pointer is all that opened it", () => {
    render(<Term name="num_ctx" />);

    fireEvent.mouseEnter(trigger());
    fireEvent.mouseLeave(trigger());

    expect(popover()).not.toBeInTheDocument();
  });

  it("stays open when the pointer leaves a popover opened by click", () => {
    render(<Term name="num_ctx" />);

    fireEvent.click(trigger());
    fireEvent.mouseLeave(trigger());

    expect(popover()).toBeInTheDocument();
  });

  it("closes on a second click", () => {
    render(<Term name="num_ctx" />);

    fireEvent.click(trigger());
    fireEvent.click(trigger());

    expect(popover()).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<Term name="num_ctx" />);
    fireEvent.focus(trigger());
    expect(popover()).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(popover()).not.toBeInTheDocument();
  });

  it("closes on blur", () => {
    render(<Term name="num_ctx" />);
    fireEvent.focus(trigger());

    fireEvent.blur(trigger());

    expect(popover()).not.toBeInTheDocument();
  });

  it("closes when the click lands outside it", () => {
    render(
      <div>
        <Term name="num_ctx" />
        <button type="button">elsewhere</button>
      </div>,
    );
    fireEvent.click(trigger());

    fireEvent.mouseDown(screen.getByRole("button", { name: "elsewhere" }));

    expect(popover()).not.toBeInTheDocument();
  });

  it("describes the word with its definition, for a screen reader", () => {
    render(<Term name="num_ctx" />);
    const button = trigger();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).not.toHaveAttribute("aria-describedby");

    fireEvent.focus(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button.getAttribute("aria-describedby")).toBe((popover() as HTMLElement).id);
  });

  it("shows the entry's aside when it has one", () => {
    render(<Term name="num_ctx" />);
    fireEvent.click(trigger());

    expect(screen.getByText("A token is roughly ¾ of a word.")).toBeInTheDocument();
  });

  it("matches the glossary key case-insensitively and can be spelled differently on the page", () => {
    render(<Term name="kv cache" />);
    // The heading uses the glossary's own spelling, not the caller's.
    fireEvent.click(screen.getByRole("button", { name: "KV cache" }));

    expect(popover()).toHaveTextContent(/working memory for the conversation so far/);
  });

  it("renders children in place of the glossary spelling", () => {
    render(<Term name="quantise">quantised</Term>);

    fireEvent.click(screen.getByRole("button", { name: "quantised" }));

    expect(popover()).toHaveTextContent(/lower precision/);
  });

  it("renders an unknown word as plain text, with no control that opens nothing", () => {
    render(<Term name="rope_freq_base" />);

    expect(screen.getByText("rope_freq_base")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("glossary", () => {
  it("defines every machine word Remuda puts in front of a user", () => {
    for (const word of [
      "num_ctx",
      "num_gpu",
      "KV cache",
      "quantise",
      "keep_alive",
      "seed",
      "temperature",
      "top_p",
      "tokens/s",
      "Modelfile",
      "variant",
    ]) {
      expect(lookupTerm(word), word).toBeDefined();
    }
  });

  it("keeps every definition to three sentences or fewer", () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      const sentences = entry.definition.split(/[.?!]\s+/).length;
      expect(sentences, key).toBeLessThanOrEqual(3);
      expect(entry.term.length, key).toBeGreaterThan(0);
    }
  });
});
