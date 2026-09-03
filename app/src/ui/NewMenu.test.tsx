/**
 * The rail's "+ New" menu (docs/mockup-new-menu.html §01–§03).
 *
 * The behaviour worth pinning down is *when the model question is asked*.
 * Asking always would be safe and annoying; never asking would bind a chat
 * to a model the user never chose. The rule is one line — ask only when the
 * answer is ambiguous — and each branch of it is a test here.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import "../chat/test/localStorage";
import { Sidebar } from "./Sidebar";
import { RemudaProvider } from "./state";
import { FakeClient, makeModel } from "./test/FakeClient";
import { SESSIONS_STORAGE_KEY } from "../chat/sessions";

function renderRail(client: FakeClient) {
  return render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <Sidebar />
    </RemudaProvider>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "New" }));
}

function storedSessions(): { model: string }[] {
  return JSON.parse(window.localStorage.getItem(SESSIONS_STORAGE_KEY) ?? "[]");
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("+ New", () => {
  it("is never disabled, even with no server and no models", () => {
    renderRail(new FakeClient({ models: [], connected: false }));
    expect(screen.getByRole("button", { name: "New" })).toBeEnabled();
  });

  it("offers both branches, chat first", () => {
    renderRail(new FakeClient({ models: [] }));
    openMenu();
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("New chat");
    expect(items[1]).toHaveTextContent("New benchmark");
  });

  it("starts a chat outright when exactly one model is resident", async () => {
    const client = new FakeClient({ models: [makeModel({ tag: "a:7b", isLoaded: true })] });
    renderRail(client);
    openMenu();
    await screen.findByText("Talk to a:7b");
    fireEvent.click(screen.getByRole("menuitem", { name: /New chat/ }));

    // No question — one resident model is not a choice.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(storedSessions()).toHaveLength(1));
    expect(storedSessions()[0]?.model).toBe("a:7b");
  });

  it("asks which model when several are resident, preselecting the active one", async () => {
    const client = new FakeClient({
      models: [
        makeModel({ tag: "a:7b", isLoaded: true }),
        makeModel({ tag: "b:7b", isLoaded: true }),
      ],
    });
    renderRail(client);
    openMenu();
    await screen.findByText("Choose from 2 models in memory");
    fireEvent.click(screen.getByRole("menuitem", { name: /New chat/ }));

    const dialog = screen.getByRole("dialog", { name: "Which model?" });
    // Preselected to what newChat() would have bound to on its own, so
    // confirming reproduces the old behaviour exactly.
    const checked = within(dialog).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveTextContent("a:7b");

    fireEvent.click(within(dialog).getByRole("radio", { name: /b:7b/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(storedSessions()).toHaveLength(1));
    expect(storedSessions()[0]?.model).toBe("b:7b");
  });

  it("asks which model to load when none is resident, and loads nothing until told", async () => {
    const client = new FakeClient({ models: [makeModel({ tag: "a:7b" })] });
    renderRail(client);
    openMenu();
    await screen.findByText("Pick a model to load");
    fireEvent.click(screen.getByRole("menuitem", { name: /New chat/ }));

    const dialog = screen.getByRole("dialog", { name: "Load a model" });
    expect(within(dialog).getByRole("button", { name: "Load and start chat" })).toBeInTheDocument();
    // SPEC §5.1: opening the question loads nothing.
    expect(storedSessions()).toHaveLength(0);
  });

  it("offers the full installed list behind 'Load a different model…'", async () => {
    const client = new FakeClient({
      models: [
        makeModel({ tag: "a:7b", isLoaded: true }),
        makeModel({ tag: "b:7b", isLoaded: true }),
        makeModel({ tag: "cold:13b" }),
      ],
    });
    renderRail(client);
    openMenu();
    await screen.findByText("Choose from 2 models in memory");
    fireEvent.click(screen.getByRole("menuitem", { name: /New chat/ }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("radio", { name: /cold:13b/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Load a different model/ }));
    expect(within(dialog).getByRole("radio", { name: /cold:13b/ })).toBeInTheDocument();
    // No endpoint reports OLLAMA_MAX_LOADED_MODELS, so this states the fact
    // and claims no number.
    expect(within(dialog).getByText(/may evict a model already in memory/)).toBeInTheDocument();
  });

  it("does not warn about eviction when nothing is resident to evict", async () => {
    renderRail(new FakeClient({ models: [makeModel({ tag: "a:7b" })] }));
    openMenu();
    await screen.findByText("Pick a model to load");
    fireEvent.click(screen.getByRole("menuitem", { name: /New chat/ }));
    expect(screen.queryByText(/may evict a model already in memory/)).not.toBeInTheDocument();
  });

  it("makes a benchmark with nothing resident, and never asks for a model", async () => {
    renderRail(new FakeClient({ models: [makeModel({ tag: "a:7b" })] }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /New benchmark/ }));

    // Straight to the page: a lane is model + Modelfile, chosen there, and
    // the weights are Run's problem.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Untitled benchmark")).toBeInTheDocument(),
    );
  });

  it("opens on ArrowDown from the button, with the first item focused", () => {
    renderRail(new FakeClient({ models: [] }));
    const button = screen.getByRole("button", { name: "New" });
    button.focus();
    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")[0]).toHaveFocus();
  });

  it("cycles the menu with the arrow keys, wrapping at both ends", () => {
    renderRail(new FakeClient({ models: [] }));
    openMenu();
    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    // Wraps rather than dead-ending on the last item.
    fireEvent.keyDown(items[1]!, { key: "ArrowDown" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0]!, { key: "ArrowUp" });
    expect(items[1]).toHaveFocus();
  });

  it("moves the picker's selection with the arrow keys", async () => {
    const client = new FakeClient({
      models: [
        makeModel({ tag: "a:7b", isLoaded: true, sizeBytes: 9_000_000_000 }),
        makeModel({ tag: "b:7b", isLoaded: true, sizeBytes: 4_000_000_000 }),
      ],
    });
    renderRail(client);
    openMenu();
    await screen.findByText("Choose from 2 models in memory");
    fireEvent.click(screen.getByRole("menuitem", { name: /New chat/ }));

    const dialog = screen.getByRole("dialog");
    const checked = () =>
      within(dialog).getAllByRole("radio").find((r) => r.getAttribute("aria-checked") === "true");
    expect(checked()).toHaveTextContent("a:7b");
    // Arrows must work from the dialog itself, which is what has focus when
    // it opens — nobody clicks a row before pressing Down.
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(checked()).toHaveTextContent("b:7b");
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    expect(checked()).toHaveTextContent("a:7b");
  });

  it("confirms on Enter — '+ New, Enter, Enter' is the fast path", async () => {
    const client = new FakeClient({
      models: [
        makeModel({ tag: "a:7b", isLoaded: true }),
        makeModel({ tag: "b:7b", isLoaded: true }),
      ],
    });
    renderRail(client);
    openMenu();
    await screen.findByText("Choose from 2 models in memory");
    fireEvent.click(screen.getByRole("menuitem", { name: /New chat/ }));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    // Enter takes the preselected model, which is what newChat() would have
    // bound to on its own — the picker costs a keystroke, not a decision.
    await waitFor(() => expect(storedSessions()).toHaveLength(1));
    expect(storedSessions()[0]?.model).toBe("a:7b");
  });

  it("closes on Escape and hands focus back to the button", () => {
    renderRail(new FakeClient({ models: [] }));
    openMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toHaveFocus();
  });
});
