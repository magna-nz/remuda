import "../chat/test/localStorage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoadPane } from "./LoadPane";
import { TopNav } from "./TopNav";
import { ChatView } from "../chat/ChatView";
import { Sidebar } from "./Sidebar";
import { RemudaProvider } from "./state";
import { FakeClient, makeModel } from "./test/FakeClient";
import type { RunningModel } from "../api/types";

/**
 * Two quantisations of one model (the quant lives in the tag, as an upstream
 * pull names it), a second single-quant model, and a tuning built FROM the Q4
 * weights specifically.
 */
function fixtureModels() {
  return [
    makeModel({ tag: "llama3.1:8b-q4_K_M", sizeBytes: 4_700_000_000, quantization: "Q4_K_M" }),
    makeModel({ tag: "llama3.1:8b-q8_0", sizeBytes: 8_500_000_000, quantization: "Q8_0" }),
    makeModel({ tag: "mistral:7b", sizeBytes: 4_100_000_000, quantization: "Q4_0" }),
    makeModel({
      tag: "support-bot:latest",
      isVariant: true,
      base: "llama3.1:8b-q4_K_M",
      sizeBytes: 4_700_000_000,
    }),
  ];
}

async function openPane(client: FakeClient) {
  render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <TopNav />
      <LoadPane />
    </RemudaProvider>,
  );
  fireEvent.click(screen.getByTitle("Choose and load a model"));
  await screen.findByText("mistral:7b");
}

/** Open the pane and drill into the two-quant model. */
async function openDetail(client: FakeClient) {
  await openPane(client);
  fireEvent.click(screen.getByText("llama3.1:8b"));
  await screen.findByText("Q4_K_M");
}

/**
 * Load the Q4 weights, reopen the pane — which lands back on the live quant's
 * detail step — then step up to the memory tray, where ejecting now lives.
 */
async function openTrayWithLoaded(client: FakeClient) {
  await openDetail(client);
  fireEvent.click(screen.getByRole("button", { name: "Load model" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 2000 });
  fireEvent.click(screen.getByTitle("Choose and load a model"));
  fireEvent.click(await screen.findByRole("button", { name: "View in memory" }));
  await screen.findByText("In memory");
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("LoadPane", () => {
  it("lists one row per model, not one per installed tag", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openPane(client);

    // The two quants of llama3.1 collapse into a single row, and the tuning
    // isn't a top-level model at all.
    expect(screen.getByText("llama3.1:8b")).toBeInTheDocument();
    expect(screen.getByText("2 quants · 1 Modelfile")).toBeInTheDocument();
    expect(screen.getByText("mistral:7b")).toBeInTheDocument();
    expect(screen.getByText("1 quant · base only")).toBeInTheDocument();
    expect(screen.queryByText("llama3.1:8b-q4_K_M")).not.toBeInTheDocument();
    expect(screen.queryByText("support-bot:latest")).not.toBeInTheDocument();
    // The quant/Modelfile pickers belong to step 2.
    expect(screen.queryByText("Original (base)")).not.toBeInTheDocument();
  });

  it("badges a model that has Modelfiles, and keeps the badge once it's loaded", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openPane(client);

    // Nothing loaded: the model with a tuning is badged, the base-only one
    // isn't, and no row claims to be in memory.
    expect(screen.getByText("tuned")).toBeInTheDocument();
    expect(screen.queryByText("loaded")).not.toBeInTheDocument();
  });

  it("shows tuned and loaded together — one is a fact, the other a state", async () => {
    const models = fixtureModels().map((m) =>
      m.tag === "llama3.1:8b-q4_K_M" ? { ...m, isLoaded: true } : m,
    );
    const client = new FakeClient({ models });
    // A loaded model opens on its detail step; step back to see the row.
    await openPane(client);
    fireEvent.click(screen.getByLabelText("Back to model list"));

    expect(screen.getByText("tuned")).toBeInTheDocument();
    expect(screen.getByText("loaded")).toBeInTheDocument();
  });

  it("drilling in shows each quantisation with its literal tag, and that quant's Modelfiles", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openDetail(client);

    expect(screen.getByText("Q4_K_M")).toBeInTheDocument();
    expect(screen.getByText("Q8_0")).toBeInTheDocument();
    // Derived grouping, so the real tags stay on screen. The Q4 tag shows
    // twice: on its quant row, and in the "loads <tag>" summary below.
    expect(screen.getAllByText("llama3.1:8b-q4_K_M")).toHaveLength(2);
    expect(screen.getByText("llama3.1:8b-q8_0")).toBeInTheDocument();
    expect(screen.getByText("4.7 GB")).toBeInTheDocument();
    expect(screen.getByText("8.5 GB")).toBeInTheDocument();

    // Q4 is selected by default and owns the tuning.
    expect(screen.getByText("Original (base)")).toBeInTheDocument();
    expect(screen.getByText("support-bot · tuned")).toBeInTheDocument();
    expect(screen.getByText("＋ New Modelfile")).toBeEnabled();
    // And the pane names the exact tag Load will send.
    expect(screen.getByText("llama3.1:8b-q4_K_M", { selector: "code" })).toBeInTheDocument();
  });

  it("goes back to the model list", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openDetail(client);

    fireEvent.click(screen.getByRole("button", { name: "Back to model list" }));

    expect(await screen.findByText("2 quants · 1 Modelfile")).toBeInTheDocument();
    expect(screen.queryByText("Q8_0")).not.toBeInTheDocument();
  });

  it("switching quantisation drops a tuning built on the other quant and says so", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openDetail(client);

    fireEvent.click(screen.getByText("support-bot · tuned"));
    fireEvent.click(screen.getByText("Q8_0"));

    // Q8 has no tunings of its own: back to Original, with the reason shown.
    expect(screen.queryByText("support-bot · tuned")).not.toBeInTheDocument();
    expect(screen.getByText(/support-bot is built on the other quantisation/)).toBeInTheDocument();
    expect(screen.getByText("llama3.1:8b-q8_0", { selector: "code" })).toBeInTheDocument();
  });

  it("clicking Load sends the selected tuning's tag and updates the control", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openDetail(client);

    fireEvent.click(screen.getByText("support-bot · tuned"));
    fireEvent.click(screen.getByRole("button", { name: "Load model" }));

    await waitFor(() => expect(client.loadCalls).toEqual([{ tag: "support-bot:latest", keepAlive: "5m" }]));
    await waitFor(() => expect(screen.getByText("llama3.1:8b · Q4_K_M · support-bot")).toBeInTheDocument());
    // The pane auto-closes a moment after a successful load.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 2000 });
  });

  it("loads the base weights when Original (base) is the pick", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openDetail(client);

    fireEvent.click(screen.getByText("Q8_0"));
    fireEvent.click(screen.getByRole("button", { name: "Load model" }));

    await waitFor(() => expect(client.loadCalls).toEqual([{ tag: "llama3.1:8b-q8_0", keepAlive: "5m" }]));
    await waitFor(() => expect(screen.getByText("llama3.1:8b · Q8_0 · Original")).toBeInTheDocument());
  });

  it("reopening on a loaded model skips straight to its quantisation", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openDetail(client);
    fireEvent.click(screen.getByText("Q8_0"));
    fireEvent.click(screen.getByRole("button", { name: "Load model" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 2000 });

    fireEvent.click(screen.getByTitle("Choose and load a model"));

    // Detail step, on the live quant, offering a reload rather than a load.
    expect(await screen.findByRole("button", { name: "Reload model" })).toBeInTheDocument();
    // The quant's own note, plus the collapsed runtime line above it.
    expect(screen.getAllByText(/in memory/i).length).toBeGreaterThan(0);
    expect(screen.getByText("In memory")).toBeInTheDocument();
  });

  it("filters the model list by name", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openPane(client);

    fireEvent.change(screen.getByLabelText("Filter models"), { target: { value: "mist" } });

    expect(screen.getByText("mistral:7b")).toBeInTheDocument();
    expect(screen.queryByText("llama3.1:8b")).not.toBeInTheDocument();
  });

  it("surfaces a failed load's error text and keeps the pane open (SPEC §9)", async () => {
    const client = new FakeClient({
      models: fixtureModels(),
      failLoad: 'Ollama /api/generate failed (500): model "llama3.1:8b" busy',
    });
    await openDetail(client);

    fireEvent.click(screen.getByRole("button", { name: "Load model" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('model "llama3.1:8b" busy');
    // The pane stays open with the button re-enabled for a retry.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load model" })).toBeEnabled();
  });

  it("disables the Load button while the server is disconnected", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    // Fast poll so the dropped connection is noticed without UI interaction.
    render(
      <RemudaProvider client={client} pollIntervalMs={25}>
        <TopNav />
        <LoadPane />
      </RemudaProvider>,
    );
    fireEvent.click(screen.getByTitle("Choose and load a model"));
    fireEvent.click(await screen.findByText("llama3.1:8b"));
    await screen.findByText("Q4_K_M");

    client.connected = false;
    await waitFor(() => expect(screen.getByRole("button", { name: "Load model" })).toBeDisabled());
  });

  it("deletes the selected quantisation, confirming first (toggle on by default, SPEC §8)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const client = new FakeClient({ models: fixtureModels() });
    await openDetail(client);

    // Delete acts on the quant in hand — the tag, not the derived model name.
    fireEvent.click(screen.getByRole("button", { name: "Delete llama3.1:8b-q4_K_M" }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("llama3.1:8b-q4_K_M"));
    await waitFor(() => expect(client.deleteCalls).toEqual(["llama3.1:8b-q4_K_M"]));
    // Back on the list. llama3.1 is now a one-quant model, and support-bot —
    // whose base was the tag just deleted — is left standing on its own: the
    // real client resolves a variant's base against the *installed* set, so
    // an unresolvable parent makes the tag a base in its own right (SPEC §12
    // item 3, "a variant whose base was deleted"). Three rows, each reading
    // "1 quant · base only".
    await waitFor(() => expect(screen.getAllByText("1 quant · base only")).toHaveLength(3));
    expect(screen.queryByText("2 quants · 1 Modelfile")).not.toBeInTheDocument();
  });

  it("skips window.confirm when 'Confirm before deleting a model' is off", async () => {
    // The toggle is real, persisted store state (state.tsx) — seed it off
    // the way Settings.tsx would leave it.
    window.localStorage.setItem("remuda.settings.v1", JSON.stringify({ confirmDeleteModel: false }));
    const confirmSpy = vi.spyOn(window, "confirm");
    const client = new FakeClient({ models: fixtureModels() });
    await openDetail(client);

    fireEvent.click(screen.getByRole("button", { name: "Delete llama3.1:8b-q4_K_M" }));

    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(client.deleteCalls).toEqual(["llama3.1:8b-q4_K_M"]));
  });

  it("prompts toward Pull when no models are installed (SPEC §5.5)", async () => {
    const client = new FakeClient({ models: [] });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
        <LoadPane />
        <Sidebar />
      </RemudaProvider>,
    );
    fireEvent.click(screen.getByTitle("Choose and load a model"));

    const pullButton = await screen.findByRole("button", { name: "Pull your first model" });
    fireEvent.click(pullButton);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get Models" })).toHaveAttribute("aria-pressed", "true");
  });

  it("ejects a model from the memory tray, freeing it without closing the pane", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openTrayWithLoaded(client);

    fireEvent.click(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" }));

    // keep_alive: 0 against the tag that was in memory (SPEC §7).
    await waitFor(() => expect(client.unloadCalls).toEqual(["llama3.1:8b-q4_K_M"]));
    // The pane stays put and the tray empties: the top control resets and
    // the row — with its Eject — is gone.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("No model loaded")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^Eject/ })).not.toBeInTheDocument();
  });

  it("offers no tray until something is actually loaded", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openDetail(client);

    expect(screen.getByRole("button", { name: "Load model" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Eject/ })).not.toBeInTheDocument();
    expect(screen.queryByText("In memory")).not.toBeInTheDocument();
  });

  it("ejects the row the user pointed at, not merely the first resident model", async () => {
    // Two models resident at once — the case the old single-Eject button
    // could not express at all.
    const models = fixtureModels().map((m) =>
      m.tag === "llama3.1:8b-q4_K_M" || m.tag === "mistral:7b" ? { ...m, isLoaded: true } : m,
    );
    const client = new FakeClient({ models });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
        <LoadPane />
      </RemudaProvider>,
    );
    fireEvent.click(screen.getByTitle("Choose and load a model"));
    // Two resident models: the pane opens on the tray rather than guessing
    // which one to show.
    await screen.findByText("In memory");
    expect(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eject mistral:7b" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Eject mistral:7b" }));

    await waitFor(() => expect(client.unloadCalls).toEqual(["mistral:7b"]));
    // The other one stays put.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" })).toBeInTheDocument(),
    );
  });

  it("Eject all frees every resident model, and only shows up when there's more than one", async () => {
    const models = fixtureModels().map((m) =>
      m.tag === "llama3.1:8b-q4_K_M" || m.tag === "mistral:7b" ? { ...m, isLoaded: true } : m,
    );
    const client = new FakeClient({ models });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
        <LoadPane />
      </RemudaProvider>,
    );
    fireEvent.click(screen.getByTitle("Choose and load a model"));
    await screen.findByText("2 models in memory");

    fireEvent.click(screen.getByRole("button", { name: "Eject all" }));

    await waitFor(() => expect(client.unloadCalls.sort()).toEqual(["llama3.1:8b-q4_K_M", "mistral:7b"]));
    await waitFor(() => expect(screen.getByText("No model loaded")).toBeInTheDocument());
  });

  it("Keep re-sends the load with keep_alive -1", async () => {
    // A row with a live countdown, so the control reads "Keep" rather than
    // offering to hand an already-pinned model back to the clock.
    const client = loadedFixture([
      {
        tag: "llama3.1:8b-q4_K_M",
        sizeBytes: 4_700_000_000,
        sizeVramBytes: 4_700_000_000,
        contextLength: 8192,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ]);
    await openLoadedTray(client);

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    // The only way to restate keep_alive for resident weights is to re-load.
    await waitFor(() =>
      expect(client.loadCalls).toContainEqual({ tag: "llama3.1:8b-q4_K_M", keepAlive: -1 }),
    );
  });

  it("surfaces a failed eject's error text verbatim and keeps the model loaded (SPEC §9)", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openTrayWithLoaded(client);
    client.failUnload = "Ollama /api/generate failed (500): unable to stop model";

    fireEvent.click(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("unable to stop model");
    // Still resident, and the button is back for a retry.
    expect(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" })).toBeEnabled();
  });

  it("disables Eject while a reply is streaming (SPEC §8: one generation at a time)", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
        <LoadPane />
        <Sidebar />
        <ChatView />
      </RemudaProvider>,
    );
    // Load a model so New chat has something to bind to, then start a reply
    // and leave it mid-stream.
    fireEvent.click(screen.getByTitle("Choose and load a model"));
    fireEvent.click(await screen.findByText("llama3.1:8b"));
    await screen.findByText("Q4_K_M");
    fireEvent.click(screen.getByRole("button", { name: "Load model" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 2000 });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await act(async () => {});
    client.emitChat({ content: "Hel", done: false });
    await screen.findByText("Hel");

    fireEvent.click(screen.getByTitle("Choose and load a model"));
    fireEvent.click(await screen.findByRole("button", { name: "View in memory" }));
    const eject = await screen.findByRole("button", { name: "Eject llama3.1:8b-q4_K_M" });
    expect(eject).toBeDisabled();
    expect(eject).toHaveAttribute("title", "Wait for the reply to finish");

    // Once the stream ends, it comes back.
    client.emitChat({ content: "lo!", done: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" })).toBeEnabled());
  });

  it("empties the tray when the server goes away — an unreachable Ollama is not a memory readout", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    // Fast poll so the dropped connection is noticed without UI interaction.
    render(
      <RemudaProvider client={client} pollIntervalMs={25}>
        <TopNav />
        <LoadPane />
      </RemudaProvider>,
    );
    fireEvent.click(screen.getByTitle("Choose and load a model"));
    fireEvent.click(await screen.findByText("llama3.1:8b"));
    await screen.findByText("Q4_K_M");
    fireEvent.click(screen.getByRole("button", { name: "Load model" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 2000 });
    fireEvent.click(screen.getByTitle("Choose and load a model"));
    fireEvent.click(await screen.findByRole("button", { name: "View in memory" }));
    await screen.findByRole("button", { name: "Eject llama3.1:8b-q4_K_M" });

    client.connected = false;

    // The tray is a live readout of /api/ps. With the server unreachable we
    // no longer know what's resident, so it says nothing rather than
    // offering to eject something that may already be gone.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Eject llama3.1:8b-q4_K_M" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("In memory")).not.toBeInTheDocument();
  });
});

/** A model already loaded, with a scripted /api/ps readout (SPEC §5.1). */
function loadedFixture(running: RunningModel[]) {
  const models = fixtureModels().map((m) => (m.tag === "llama3.1:8b-q4_K_M" ? { ...m, isLoaded: true } : m));
  return new FakeClient({ models, running });
}

/**
 * Open the pane on a model that's already loaded — with exactly one resident
 * it lands on detail — then step up to the memory tray, which is where the
 * full runtime readout now lives.
 */
async function openLoadedTray(client: FakeClient) {
  render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <TopNav />
      <LoadPane />
    </RemudaProvider>,
  );
  fireEvent.click(screen.getByTitle("Choose and load a model"));
  fireEvent.click(await screen.findByRole("button", { name: "View in memory" }));
  await screen.findByText("In memory");
}

describe("LoadPane memory tray (SPEC §5.1, docs/mockup-memory.html §02)", () => {
  it("shows a full-GPU row and the top-bar chip — no CPU note, no spill warning", async () => {
    const client = loadedFixture([
      {
        tag: "llama3.1:8b-q4_K_M",
        sizeBytes: 4_700_000_000,
        sizeVramBytes: 4_700_000_000,
        contextLength: 8192,
        expiresAt: null,
      },
    ]);
    await openLoadedTray(client);

    // Top-bar chip and the row's own badge — both read the same figure.
    expect(screen.getAllByText("100% GPU")).toHaveLength(2);
    expect(document.querySelectorAll(".rt-inline.spill")).toHaveLength(0);
    expect(document.querySelectorAll(".slot.spill")).toHaveLength(0);
    // Nothing off-GPU: no CPU share, no spill warning.
    expect(screen.queryByText(/on CPU$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/running on the CPU/)).not.toBeInTheDocument();
    // The row's own size, and the tray's total — identical with one model
    // resident, so each is asserted where it lives rather than by text alone.
    expect(document.querySelector(".slot .slot-sub")).toHaveTextContent("4.7 GB");
    expect(document.querySelector(".pfield > label .rhs")).toHaveTextContent("4.7 GB");
    // Context equals the model's own max, so no "/ max" suffix.
    expect(screen.getByText(/^ctx 8,192$/)).toBeInTheDocument();
    // expiresAt: null is an infinite keep_alive — a state, not a countdown.
    expect(screen.getByText("kept")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" })).toBeInTheDocument();
    // Already pinned, so the control offers the other direction.
    expect(screen.getByRole("button", { name: "Let expire" })).toBeInTheDocument();
  });

  it("spills to CPU: amber chip, an amber rail, the CPU share and the warning", async () => {
    const client = loadedFixture([
      {
        tag: "llama3.1:8b-q4_K_M",
        sizeBytes: 4_700_000_000,
        sizeVramBytes: 2_900_000_000,
        contextLength: 8192,
        expiresAt: null,
      },
    ]);
    await openLoadedTray(client);

    expect(screen.getAllByText("62% GPU")).toHaveLength(2);
    expect(document.querySelectorAll(".rt-inline.spill")).toHaveLength(2);
    // The rail is the at-a-glance signal, so it must actually flip.
    expect(document.querySelectorAll(".slot.spill")).toHaveLength(1);
    expect(screen.getByText("1.8 GB on CPU")).toBeInTheDocument();
    expect(screen.getByText(/running on the CPU/)).toHaveTextContent("1.8 GB is running on the CPU.");
  });

  it("renders no percentage or bar when sizeBytes is 0, rather than dividing by zero", async () => {
    const client = loadedFixture([
      { tag: "llama3.1:8b-q4_K_M", sizeBytes: 0, sizeVramBytes: 0, contextLength: null, expiresAt: null },
    ]);
    await openLoadedTray(client);

    expect(screen.queryByText(/% GPU/)).not.toBeInTheDocument();
    expect(document.querySelector(".rt-bar")).not.toBeInTheDocument();
    // A size the server reported as 0 is "it didn't say" — the row omits the
    // figure rather than claiming the model occupies 0 MB. Same for context.
    expect(screen.queryByText(/GB$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^ctx /)).not.toBeInTheDocument();
    // The row is still there, and can still be ejected.
    expect(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" })).toBeInTheDocument();
  });

  it("shows the model's trained max alongside the running context length", async () => {
    const client = loadedFixture([
      {
        tag: "llama3.1:8b-q4_K_M",
        sizeBytes: 4_700_000_000,
        sizeVramBytes: 4_700_000_000,
        contextLength: 2048,
        expiresAt: null,
      },
    ]);
    await openLoadedTray(client);

    expect(screen.getByText(/^ctx 2,048/)).toBeInTheDocument();
    expect(screen.getByText("/ 8,192")).toBeInTheDocument();
  });

  it("totals the resident models rather than making the user add them up", async () => {
    const models = fixtureModels().map((m) =>
      m.tag === "llama3.1:8b-q4_K_M" || m.tag === "mistral:7b" ? { ...m, isLoaded: true } : m,
    );
    const client = new FakeClient({
      models,
      running: [
        {
          tag: "llama3.1:8b-q4_K_M",
          sizeBytes: 4_700_000_000,
          sizeVramBytes: 4_700_000_000,
          contextLength: 8192,
          expiresAt: null,
        },
        {
          tag: "mistral:7b",
          sizeBytes: 4_100_000_000,
          sizeVramBytes: 4_100_000_000,
          contextLength: 8192,
          expiresAt: null,
        },
      ],
    });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
        <LoadPane />
      </RemudaProvider>,
    );
    fireEvent.click(screen.getByTitle("Choose and load a model"));
    await screen.findByText("In memory");

    // The tray's own total, and the same figure summarised in the top nav.
    expect(screen.getByText("8.8 GB")).toBeInTheDocument();
    expect(screen.getByText("2 models · 8.8 GB")).toBeInTheDocument();
  });

  it("goes amber in the nav when any one resident model spills, not only when all do", async () => {
    const models = fixtureModels().map((m) =>
      m.tag === "llama3.1:8b-q4_K_M" || m.tag === "mistral:7b" ? { ...m, isLoaded: true } : m,
    );
    const client = new FakeClient({
      models,
      running: [
        {
          tag: "llama3.1:8b-q4_K_M",
          sizeBytes: 4_000_000_000,
          sizeVramBytes: 4_000_000_000,
          contextLength: 8192,
          expiresAt: null,
        },
        {
          tag: "mistral:7b",
          sizeBytes: 4_000_000_000,
          sizeVramBytes: 2_000_000_000,
          contextLength: 8192,
          expiresAt: null,
        },
      ],
    });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
        <LoadPane />
      </RemudaProvider>,
    );
    fireEvent.click(screen.getByTitle("Choose and load a model"));
    await screen.findByText("In memory");

    // Pooled: 6 GB of 8 GB in VRAM. Under 100%, so the nav chip warns.
    expect(document.querySelector(".modelctl .rt-inline")).toHaveClass("spill");
    expect(screen.getByText("75% GPU")).toBeInTheDocument();
    // But only the model that actually spills gets an amber rail.
    expect(document.querySelectorAll(".slot.spill")).toHaveLength(1);
  });

  it("ticks the expiry countdown once a second and stops at zero rather than going negative", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const client = loadedFixture([
        {
          tag: "llama3.1:8b-q4_K_M",
          sizeBytes: 4_700_000_000,
          sizeVramBytes: 4_700_000_000,
          contextLength: 8192,
          expiresAt: "2026-01-01T00:00:05.000Z",
        },
      ]);
      render(
        <RemudaProvider client={client} pollIntervalMs={1_000_000}>
          <TopNav />
          <LoadPane />
        </RemudaProvider>,
      );
      fireEvent.click(screen.getByTitle("Choose and load a model"));
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "View in memory" }));
      await act(async () => {});
      expect(screen.getByText("expires 5s")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText("expires 3s")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByText("expires 0s")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LoadPane capability chips (SPEC §5.1, §2)", () => {
  function fixtureWithCapabilities() {
    return [
      makeModel({ tag: "llama3.1:8b", capabilities: ["completion", "tools", "thinking"] }),
      makeModel({ tag: "nomic-embed-text:latest", capabilities: ["embedding"] }),
      makeModel({ tag: "vision-model:latest", capabilities: ["completion", "vision", "frobnicate"] }),
    ];
  }

  it("renders known capabilities, an embedding model's 'no chat' chip, and an unrecognised one without crashing", async () => {
    const client = new FakeClient({ models: fixtureWithCapabilities() });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
        <LoadPane />
      </RemudaProvider>,
    );
    fireEvent.click(screen.getByTitle("Choose and load a model"));
    await screen.findByText("llama3.1:8b");

    // completion never gets its own chip — it's the unremarkable default.
    expect(screen.queryByText("completion")).not.toBeInTheDocument();
    expect(screen.getByText("tools")).toBeInTheDocument();
    expect(screen.getByText("thinking")).toBeInTheDocument();
    // No `completion` capability: the embedding chip clarifies it can't chat.
    expect(screen.getByText("embedding · no chat")).toBeInTheDocument();
    // vision is known; frobnicate isn't — both render, neither throws.
    expect(screen.getByText("vision")).toBeInTheDocument();
    expect(screen.getByText("frobnicate")).toBeInTheDocument();
  });
});
