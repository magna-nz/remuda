import "../chat/test/localStorage";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { PaneHelp, PaneHelpToggle } from "./PaneHelp";
import { HELP_STORAGE_KEY, reopenAll } from "./persistence";

/** A pane header plus its strip, the way a real surface composes the two. */
function Pane({ paneId, title }: { paneId: string; title: string }) {
  return (
    <div>
      <div className="pane-h">
        <b>{title}</b>
        <PaneHelpToggle paneId={paneId} />
      </div>
      <PaneHelp
        paneId={paneId}
        title={`${title} — re-run your prompts after a change`}
        what="A saved set of prompts, replayed against the current model on one click."
        why="It is how you catch the behaviour you broke while fixing the behaviour you meant to."
        steps={["Add prompts from any chat.", "Press Run all after saving a Modelfile.", "Read the rows badged Changed."]}
        note="Same or changed is a diff, not a verdict."
      />
      <p>pane body</p>
    </div>
  );
}

function strip(title: string): HTMLElement | null {
  return screen.queryByRole("region", { name: `About ${title} — re-run your prompts after a change` });
}

describe("PaneHelp", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("is open by default on a pane it has never seen", () => {
    render(<Pane paneId="bench" title="Bench" />);

    expect(strip("Bench")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About this pane" })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the three beats and the closing note", () => {
    render(<Pane paneId="bench" title="Bench" />);

    expect(screen.getByText(/replayed against the current model/)).toBeInTheDocument();
    expect(screen.getByText(/catch the behaviour you broke/)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Same or changed is a diff, not a verdict.")).toBeInTheDocument();
  });

  it("renders in flow ahead of the pane body, not as a floating layer", () => {
    render(<Pane paneId="bench" title="Bench" />);

    const region = strip("Bench") as HTMLElement;
    expect(region.style.position).toBe("");
    // The strip precedes the content it describes, so it pushes it down.
    const follows = region.compareDocumentPosition(screen.getByText("pane body"));
    expect(follows & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("closes from the strip's ✕ and from the header's ?, and reopens", () => {
    render(<Pane paneId="bench" title="Bench" />);

    fireEvent.click(screen.getByRole("button", { name: /^Close help for Bench/ }));
    expect(strip("Bench")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "About this pane" }));
    expect(strip("Bench")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "About this pane" }));
    expect(strip("Bench")).not.toBeInTheDocument();
  });

  it("keeps a dismissal across a remount", () => {
    const first = render(<Pane paneId="bench" title="Bench" />);
    fireEvent.click(screen.getByRole("button", { name: /^Close help for Bench/ }));
    first.unmount();

    render(<Pane paneId="bench" title="Bench" />);

    expect(strip("Bench")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About this pane" })).toHaveAttribute("aria-expanded", "false");
  });

  it("dismisses one pane without touching another", () => {
    render(
      <>
        <Pane paneId="bench" title="Bench" />
        <Pane paneId="format" title="Format" />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Close help for Bench/ }));

    expect(strip("Bench")).not.toBeInTheDocument();
    expect(strip("Format")).toBeInTheDocument();
  });

  it("reopenAll() restores every pane, live and without a remount", () => {
    render(
      <>
        <Pane paneId="bench" title="Bench" />
        <Pane paneId="format" title="Format" />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Close help for Bench/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Close help for Format/ }));
    expect(screen.queryAllByRole("region")).toHaveLength(0);

    act(() => reopenAll());

    expect(strip("Bench")).toBeInTheDocument();
    expect(strip("Format")).toBeInTheDocument();
  });

  it("opens everything when storage holds nonsense, and never throws", () => {
    window.localStorage.setItem(HELP_STORAGE_KEY, "{not json at all");

    expect(() => render(<Pane paneId="bench" title="Bench" />)).not.toThrow();
    expect(strip("Bench")).toBeInTheDocument();
  });

  it("points the ? at the strip it controls", () => {
    render(<Pane paneId="bench" title="Bench" />);

    const controls = screen.getByRole("button", { name: "About this pane" }).getAttribute("aria-controls");
    expect(controls).toBe("panehelp-bench");
    expect(strip("Bench")).toHaveAttribute("id", controls as string);
  });
});
