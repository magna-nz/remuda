import "../chat/test/localStorage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoadPane } from "./LoadPane";
import { TopNav } from "./TopNav";
import { ViewTabs } from "../editor/ViewTabs";
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
 * Load the Q4 weights, then reopen the pane — which lands back on the live
 * quant's detail step, where Eject lives.
 */
async function openDetailWithLoaded(client: FakeClient) {
  await openDetail(client);
  fireEvent.click(screen.getByRole("button", { name: "Load model" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 2000 });
  fireEvent.click(screen.getByTitle("Choose and load a model"));
  await screen.findByRole("button", { name: "Reload model" });
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
    expect(screen.getByText(/in memory/)).toBeInTheDocument();
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
        <ViewTabs />
      </RemudaProvider>,
    );
    fireEvent.click(screen.getByTitle("Choose and load a model"));

    const pullButton = await screen.findByRole("button", { name: "Pull your first model" });
    fireEvent.click(pullButton);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pull" })).toHaveAttribute("aria-current", "true");
  });

  it("ejects the loaded model, freeing its memory without closing the pane", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openDetailWithLoaded(client);

    fireEvent.click(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" }));

    // keep_alive: 0 against the tag that was in memory (SPEC §7).
    await waitFor(() => expect(client.unloadCalls).toEqual(["llama3.1:8b-q4_K_M"]));
    // The pane stays put and re-reads as nothing-loaded: the top control
    // resets, the reload offer becomes a plain load, and the "in memory"
    // note on the quant is gone.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("No model loaded")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Load model" })).toBeInTheDocument();
    expect(screen.queryByText(/in memory/)).not.toBeInTheDocument();
    // Nothing loaded, nothing to eject.
    expect(screen.queryByRole("button", { name: /^Eject/ })).not.toBeInTheDocument();
  });

  it("offers no Eject until something is actually loaded", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openDetail(client);

    expect(screen.getByRole("button", { name: "Load model" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Eject/ })).not.toBeInTheDocument();
  });

  it("ejects what is in memory even while another model's detail is open", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openDetailWithLoaded(client);

    // Walk over to mistral: the selection changes, the loaded model doesn't.
    fireEvent.click(screen.getByRole("button", { name: "Back to model list" }));
    fireEvent.click(await screen.findByText("mistral:7b"));
    await screen.findByText("Original (base)");

    // Load would send mistral; Eject still names — and frees — the llama tag.
    expect(screen.getByRole("button", { name: "Load model" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" }));

    await waitFor(() => expect(client.unloadCalls).toEqual(["llama3.1:8b-q4_K_M"]));
  });

  it("surfaces a failed eject's error text verbatim and keeps the model loaded (SPEC §9)", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openDetailWithLoaded(client);
    client.failUnload = "Ollama /api/generate failed (500): unable to stop model";

    fireEvent.click(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("unable to stop model");
    // Still loaded, and the button is back for a retry.
    expect(screen.getByRole("button", { name: "Reload model" })).toBeInTheDocument();
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
    const eject = await screen.findByRole("button", { name: "Eject llama3.1:8b-q4_K_M" });
    expect(eject).toBeDisabled();
    expect(eject).toHaveAttribute("title", "Wait for the reply to finish");

    // Once the stream ends, it comes back.
    client.emitChat({ content: "lo!", done: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" })).toBeEnabled());
  });

  it("disables Eject while the server is disconnected", async () => {
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
    await screen.findByRole("button", { name: "Eject llama3.1:8b-q4_K_M" });

    client.connected = false;
    await waitFor(() => expect(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" })).toBeDisabled());
  });
});

/** A model already loaded, with a scripted /api/ps readout (SPEC §5.1). */
function loadedFixture(running: RunningModel[]) {
  const models = fixtureModels().map((m) => (m.tag === "llama3.1:8b-q4_K_M" ? { ...m, isLoaded: true } : m));
  return new FakeClient({ models, running });
}

/** Open the pane on a model that's already loaded — it lands on detail directly. */
async function openLoadedDetail(client: FakeClient) {
  render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <TopNav />
      <LoadPane />
    </RemudaProvider>,
  );
  fireEvent.click(screen.getByTitle("Choose and load a model"));
  await screen.findByText("Q4_K_M");
}

describe("LoadPane runtime readout (SPEC §5.1)", () => {
  it("shows a full-GPU strip, the top-bar chip, and Eject's freed size — no RAM legend or spill warning", async () => {
    const client = loadedFixture([
      {
        tag: "llama3.1:8b-q4_K_M",
        sizeBytes: 4_700_000_000,
        sizeVramBytes: 4_700_000_000,
        contextLength: 8192,
        expiresAt: null,
      },
    ]);
    await openLoadedDetail(client);

    // Top-bar chip and the strip's own badge — both read the same figure.
    expect(screen.getAllByText("100% GPU")).toHaveLength(2);
    expect(document.querySelectorAll(".rt-inline.spill")).toHaveLength(0);
    // Nothing off-GPU: no RAM legend entry, no spill warning.
    expect(screen.queryByText(/^RAM /)).not.toBeInTheDocument();
    expect(screen.queryByText(/running on the CPU/)).not.toBeInTheDocument();
    expect(screen.getByText(/^VRAM /)).toHaveTextContent("VRAM 4.7 GB");
    // Context equals the model's own max, so no "/ max" suffix.
    expect(screen.getByText("8,192")).toBeInTheDocument();
    // expiresAt: null is an infinite keep_alive, not a broken countdown.
    expect(screen.getByText("never")).toBeInTheDocument();
    // Eject now names the memory it frees.
    expect(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" })).toHaveTextContent(
      "Eject 4.7 GB",
    );
  });

  it("spills to CPU: amber chip, a RAM legend entry, and the CPU warning", async () => {
    const client = loadedFixture([
      {
        tag: "llama3.1:8b-q4_K_M",
        sizeBytes: 4_700_000_000,
        sizeVramBytes: 2_900_000_000,
        contextLength: 8192,
        expiresAt: null,
      },
    ]);
    await openLoadedDetail(client);

    expect(screen.getAllByText("62% GPU")).toHaveLength(2);
    expect(document.querySelectorAll(".rt-inline.spill")).toHaveLength(2);
    expect(screen.getByText(/^RAM /)).toHaveTextContent("RAM 1.8 GB");
    const warning = screen.getByText(/running on the CPU/);
    expect(warning).toHaveTextContent("1.8 GB is running on the CPU.");
  });

  it("renders no percentage or bar when sizeBytes is 0, rather than dividing by zero", async () => {
    const client = loadedFixture([
      { tag: "llama3.1:8b-q4_K_M", sizeBytes: 0, sizeVramBytes: 0, contextLength: null, expiresAt: null },
    ]);
    await openLoadedDetail(client);

    expect(screen.queryByText(/% GPU/)).not.toBeInTheDocument();
    expect(document.querySelector(".rt-bar")).not.toBeInTheDocument();
    // Both unknowns render as an em dash rather than a broken number:
    // contextLength: null, and a size the server reported as 0. Addressed by
    // cell so this can't be satisfied by one dash standing in for both.
    const cellValue = (label: string) =>
      screen.getByText(label).parentElement?.querySelector(".v")?.textContent?.trim();
    // Context still shows the model's trained max beside the unknown runner
    // value, so it reads "— / 8,192"; Total size has nothing to pair with.
    expect(cellValue("Context")).toMatch(/^—/);
    expect(cellValue("Total size")).toBe("—");
    // Eject falls back to its plain label when there's nothing to size.
    // Asserted on the exact text: `toHaveTextContent("Eject")` is a substring
    // match and passed happily on the "Eject 0 MB" this is meant to prevent.
    expect(screen.getByRole("button", { name: "Eject llama3.1:8b-q4_K_M" })).toHaveTextContent(
      /^Eject$/,
    );
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
    await openLoadedDetail(client);

    expect(screen.getByText("2,048")).toBeInTheDocument();
    expect(screen.getByText("/ 8,192")).toBeInTheDocument();
  });

  it("ticks the Expires countdown once a second and stops at zero rather than going negative", async () => {
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
      expect(screen.getByText("5s")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText("3s")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByText("0s")).toBeInTheDocument();
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
