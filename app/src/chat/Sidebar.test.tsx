import "./test/localStorage";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SESSIONS_STORAGE_KEY, type ChatSession } from "./sessions";
import { Sidebar } from "../ui/Sidebar";
import { RemudaProvider } from "../ui/state";
import { FakeClient, makeModel } from "../ui/test/FakeClient";

function seedSessions(sessions: ChatSession[]) {
  window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
}

function fixtureSessions(): ChatSession[] {
  return [
    {
      id: "s-git",
      title: "Undo a git commit",
      model: "llama3.1:8b",
      messages: [{ role: "user", content: "Undo a git commit" }],
      updatedAt: new Date().toISOString(), // "now"
    },
    {
      id: "s-regex",
      title: "Explain this regex",
      model: "regex-helper:latest",
      messages: [{ role: "user", content: "Explain this regex" }],
      updatedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(), // "2d"
    },
  ];
}

function renderSidebar(client: FakeClient) {
  return render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <Sidebar />
    </RemudaProvider>,
  );
}

function fixtureClient() {
  return new FakeClient({
    models: [makeModel({ tag: "llama3.1:8b", isLoaded: true }), makeModel({ tag: "regex-helper:latest" })],
  });
}

function rowFor(title: string): HTMLElement {
  const row = screen.getByText(title).closest(".sess");
  if (!(row instanceof HTMLElement)) throw new Error(`no session row for ${title}`);
  return row;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("Sidebar session list", () => {
  it("shows title, status dot, and relative time on one line per row (SPEC §5.2)", async () => {
    seedSessions(fixtureSessions());
    renderSidebar(fixtureClient());
    // Wait for /api/ps knowledge so the dots can be judged (New chat enables
    // only once a loaded model is known).
    await waitFor(() => expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled());

    const loadedRow = rowFor("Undo a git commit");
    expect(loadedRow.querySelector(".sdot")).not.toHaveClass("off");
    expect(within(loadedRow).getByText("now")).toBeInTheDocument();
    // A closed row is one line — the tag rides the tooltip and the
    // screen-reader line, so the dot is never the only carrier of the state.
    expect(loadedRow.querySelector(".smodel")).toBeNull();
    expect(loadedRow.querySelector(".sess-open")).toHaveAttribute("title", "llama3.1:8b — loaded");
    expect(within(loadedRow).getByText("llama3.1:8b, loaded")).toHaveClass("sr-only");

    const unloadedRow = rowFor("Explain this regex");
    expect(unloadedRow.querySelector(".sdot")).toHaveClass("off");
    expect(within(unloadedRow).getByText("2d")).toBeInTheDocument();
    // ":latest" is dropped in the narrow row, like the mockup.
    expect(unloadedRow.querySelector(".sess-open")).toHaveAttribute("title", "regex-helper — not loaded");
    expect(within(unloadedRow).getByText("regex-helper, not loaded")).toHaveClass("sr-only");

    // Most-recent first.
    const titles = Array.from(document.querySelectorAll(".stitle")).map((el) => el.textContent);
    expect(titles).toEqual(["Undo a git commit", "Explain this regex"]);
  });

  it("spells the model tag out on the open chat only (SPEC §5.2)", async () => {
    seedSessions(fixtureSessions());
    renderSidebar(fixtureClient());
    await screen.findByText("Explain this regex");

    // Nothing open yet, so no row spends a second line on its tag.
    expect(document.querySelector(".smodel")).toBeNull();

    fireEvent.click(screen.getByText("Explain this regex"));

    const opened = rowFor("Explain this regex");
    expect(opened).toHaveClass("active");
    expect(within(opened).getByText("regex-helper")).toHaveClass("smodel-tag", "off");
    expect(document.querySelectorAll(".smodel")).toHaveLength(1);
  });

  it("filters by title substring", async () => {
    seedSessions(fixtureSessions());
    renderSidebar(fixtureClient());
    await screen.findByText("Undo a git commit");

    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "regex" } });
    expect(screen.queryByText("Undo a git commit")).not.toBeInTheDocument();
    expect(screen.getByText("Explain this regex")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "zzz" } });
    expect(screen.getByText("No chats match.")).toBeInTheDocument();
  });

  it("deletes a session from its row and persists the removal", async () => {
    seedSessions(fixtureSessions());
    renderSidebar(fixtureClient());
    await screen.findByText("Explain this regex");

    fireEvent.click(screen.getByRole("button", { name: "Delete Explain this regex" }));
    expect(screen.queryByText("Explain this regex")).not.toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(SESSIONS_STORAGE_KEY) ?? "[]");
      expect(stored.map((s: ChatSession) => s.id)).toEqual(["s-git"]);
    });
  });

  it("restores persisted sessions on a fresh mount (restart roundtrip)", async () => {
    seedSessions(fixtureSessions());
    const first = renderSidebar(fixtureClient());
    await screen.findByText("Undo a git commit");
    first.unmount();

    // A brand-new provider — as after an app restart — reads the same store.
    renderSidebar(fixtureClient());
    expect(screen.getByText("Undo a git commit")).toBeInTheDocument();
    expect(screen.getByText("Explain this regex")).toBeInTheDocument();
  });
});
