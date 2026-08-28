import "../chat/test/localStorage";
/**
 * Modelfile history in the editor (SPEC-tuning.md T1).
 *
 * The rule this file exists to hold down: **Restore does not create.**
 * Everything else here — snapshotting only after a successful create, the
 * content-addressed no-op re-save, the drift entry — protects the same
 * promise, that history is a safety net and never a build trigger.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "./EditorView";
import { TopNav } from "../ui/TopNav";
import { RemudaProvider, useRemuda } from "../ui/state";
import { FakeClient, makeModel } from "../ui/test/FakeClient";
import { HISTORY_STORAGE_KEY, loadHistory, type ModelfileSnapshot } from "./history";

const FIXTURE_MODELFILE = `FROM llama3.1:8b\n\nSYSTEM """Be helpful."""\n`;
const SNAPSHOT_MODELFILE = `FROM llama3.1:8b\n\nSYSTEM """Be terse."""\nPARAMETER temperature 0.4\n`;

function fixtureClient(overrides: Partial<ConstructorParameters<typeof FakeClient>[0]> = {}) {
  return new FakeClient({
    models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
    modelfile: FIXTURE_MODELFILE,
    ...overrides,
  });
}

function seedHistory(snapshots: ModelfileSnapshot[]) {
  window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(snapshots));
}

function snapshot(rawText: string, overrides: Partial<ModelfileSnapshot> = {}): ModelfileSnapshot {
  return {
    id: "snap-1",
    tag: "llama3.1:8b",
    rawText,
    savedAt: new Date(Date.now() - 60_000).toISOString(),
    kind: "save",
    ...overrides,
  };
}

/** Opens llama3.1:8b's Modelfile via the TopNav pencil, same as the other editor tests. */
async function openEditorFor(client: FakeClient, extra?: React.ReactNode) {
  render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <TopNav />
      <EditorView />
      {extra}
    </RemudaProvider>,
  );
  fireEvent.click(await screen.findByLabelText("Edit llama3.1:8b's Modelfile"));
  await screen.findByLabelText("Raw Modelfile");
}

function showHistory() {
  fireEvent.click(screen.getByRole("button", { name: "History" }));
}

function timelineEntries() {
  return within(screen.getByLabelText("Modelfile snapshots")).getAllByRole("button");
}

describe("Modelfile history", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Restore this loads the snapshot as an unsaved draft — it never calls create", async () => {
    seedHistory([snapshot(SNAPSHOT_MODELFILE)]);
    const client = fixtureClient();
    await openEditorFor(client);

    showHistory();
    fireEvent.click(screen.getByRole("button", { name: "Restore this" }));

    // The whole point: nothing was built, nothing was cycled.
    expect(client.createCalls).toEqual([]);
    expect(client.unloadCalls).toEqual([]);
    expect(client.loadCalls).toEqual([]);
    // …and nothing was recorded, either — only a real Save writes history.
    expect(loadHistory()).toHaveLength(1);

    // The draft holds the snapshot's text, dirty, in the Raw pane.
    const raw = (await screen.findByLabelText("Raw Modelfile")) as HTMLTextAreaElement;
    expect(raw.value).toBe(SNAPSHOT_MODELFILE);
    expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "true");
  });

  it("the Save after a Restore is the thing that creates, and records kind `restore`", async () => {
    // Newest snapshot is the text on screen; the older one is what we go back to.
    seedHistory([
      snapshot(FIXTURE_MODELFILE, { id: "snap-2", savedAt: "2026-02-02T00:00:00.000Z" }),
      snapshot(SNAPSHOT_MODELFILE, { id: "snap-1", savedAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    const client = fixtureClient();
    await openEditorFor(client);

    showHistory();
    fireEvent.click(timelineEntries()[1]!); // select the older snapshot
    fireEvent.click(screen.getByRole("button", { name: "Restore this" }));
    expect(client.createCalls).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.createCalls).toHaveLength(1));
    expect(client.createCalls[0]!.request.rawModelfile).toBe(SNAPSHOT_MODELFILE);
    await waitFor(() => expect(loadHistory()).toHaveLength(3));
    const newest = loadHistory()[0]!;
    expect(newest.kind).toBe("restore");
    expect(newest.rawText).toBe(SNAPSHOT_MODELFILE);
    expect(newest.parentId).toBe("snap-1"); // parented on what it was restored from
  });

  it("a successful Save records one snapshot; an identical re-save records nothing", async () => {
    const client = fixtureClient();
    await openEditorFor(client);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.createCalls).toHaveLength(1));
    await waitFor(() => expect(loadHistory()).toHaveLength(1));
    expect(loadHistory()[0]!.kind).toBe("save");
    expect(loadHistory()[0]!.rawText).toBe(FIXTURE_MODELFILE);

    // Same text, second save: the model is re-created, history is not.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.createCalls).toHaveLength(2));
    expect(loadHistory()).toHaveLength(1);

    showHistory();
    expect(timelineEntries()).toHaveLength(1);
  });

  it("a failed create writes no snapshot", async () => {
    const client = fixtureClient({ failCreate: "invalid FROM" });
    await openEditorFor(client);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("invalid FROM");

    expect(loadHistory()).toEqual([]);
    expect(window.localStorage.getItem(HISTORY_STORAGE_KEY)).toBeNull();
    showHistory();
    expect(screen.getByText(/No snapshots for/)).toBeInTheDocument();
  });

  it("marks the snapshot matching the working text as current", async () => {
    seedHistory([snapshot(FIXTURE_MODELFILE)]);
    await openEditorFor(fixtureClient());

    showHistory();
    expect(screen.getByText("current")).toBeInTheDocument();
    expect(screen.queryByText(/Edited outside Remuda/)).not.toBeInTheDocument();
  });

  it("surfaces drift: working text that is in no snapshot is not pinned on a stale one", async () => {
    seedHistory([snapshot(SNAPSHOT_MODELFILE)]);
    await openEditorFor(fixtureClient());

    showHistory();
    expect(screen.getByText("Edited outside Remuda")).toBeInTheDocument();
    expect(screen.queryByText("current")).not.toBeInTheDocument();
    // The diff still answers "what changed since then?" against the working copy.
    expect(screen.getByText(/→ working copy/)).toBeInTheDocument();
    expect(screen.getByText('SYSTEM """Be terse."""')).toBeInTheDocument();
  });

  it("timeline entries summarise the change against the snapshot before them", async () => {
    seedHistory([
      snapshot(SNAPSHOT_MODELFILE, { id: "snap-2", savedAt: "2026-02-02T00:00:00.000Z" }),
      snapshot(FIXTURE_MODELFILE, { id: "snap-1", savedAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    await openEditorFor(fixtureClient());

    showHistory();
    const entries = timelineEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("+2 −1 · SYSTEM, temperature");
    expect(entries[1]).toHaveTextContent("first snapshot");
  });
});

function PromoteHarness() {
  const { promoteToSystem } = useRemuda();
  return (
    <button type="button" onClick={() => void promoteToSystem("Answer in three sentences.")}>
      promote
    </button>
  );
}

describe("promoteToSystem", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stages the text into SYSTEM and leaves the draft dirty and unsaved", async () => {
    const client = fixtureClient();
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
        <EditorView />
        <PromoteHarness />
      </RemudaProvider>,
    );
    // Wait for the model list, so there is an active model to promote onto.
    await screen.findByLabelText("Edit llama3.1:8b's Modelfile");

    fireEvent.click(screen.getByRole("button", { name: "promote" }));

    const raw = (await screen.findByLabelText("Raw Modelfile")) as HTMLTextAreaElement;
    await waitFor(() => expect(raw.value).toContain("Answer in three sentences."));
    expect((screen.getByLabelText(/System prompt/) as HTMLTextAreaElement).value).toBe(
      "Answer in three sentences.",
    );
    expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled();
    // Staged, not saved: no create, no reload, no snapshot.
    expect(client.createCalls).toEqual([]);
    expect(client.unloadCalls).toEqual([]);
    expect(loadHistory()).toEqual([]);
  });

  it("is a no-op when nothing is loaded", async () => {
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: false })],
      modelfile: FIXTURE_MODELFILE,
    });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <EditorView />
        <PromoteHarness />
      </RemudaProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "promote" }));

    await waitFor(() => expect(client.showCalls).toEqual([]));
    expect(screen.queryByLabelText("Raw Modelfile")).not.toBeInTheDocument();
  });
});
