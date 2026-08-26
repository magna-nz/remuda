/**
 * Unsaved-changes guard (SPEC.md §8): switching away from a dirty editor
 * confirms first, and only actually navigates when the user says yes.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "./EditorView";
import { ViewTabs } from "./ViewTabs";
import { TopNav } from "../ui/TopNav";
import { RemudaProvider, useRemuda } from "../ui/state";
import { FakeClient, makeModel } from "../ui/test/FakeClient";

const FIXTURE_MODELFILE = `FROM llama3.1:8b\n\nSYSTEM """Be helpful."""\n`;

/** Minimal stand-in for App.tsx's view switch, using only the public store. */
function MainPanel() {
  const { view } = useRemuda();
  if (view === "modelfile") return <EditorView />;
  return <div data-testid="chat-placeholder">chat</div>;
}

async function openEditor(client: FakeClient) {
  render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <TopNav />
      <ViewTabs />
      <MainPanel />
    </RemudaProvider>,
  );
  fireEvent.click(await screen.findByLabelText("Edit llama3.1:8b's Modelfile"));
  await screen.findByLabelText("Raw Modelfile");
}

describe("unsaved Modelfile changes guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declining the confirm keeps the editor open", async () => {
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
      modelfile: FIXTURE_MODELFILE,
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openEditor(client);

    fireEvent.change(screen.getByLabelText(/System prompt/), { target: { value: "dirty edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByLabelText("Raw Modelfile")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-placeholder")).not.toBeInTheDocument();
  });

  it("accepting the confirm switches views", async () => {
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
      modelfile: FIXTURE_MODELFILE,
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await openEditor(client);

    fireEvent.change(screen.getByLabelText(/System prompt/), { target: { value: "dirty edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    await waitFor(() => expect(screen.getByTestId("chat-placeholder")).toBeInTheDocument());
  });
});
