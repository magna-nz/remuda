import "../chat/test/localStorage";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoadPane } from "./LoadPane";
import { TopNav } from "./TopNav";
import { ViewTabs } from "../editor/ViewTabs";
import { RemudaProvider } from "./state";
import { FakeClient, makeModel } from "./test/FakeClient";

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
    // Back on the list, where llama3.1 is now a one-quant model: the deleted
    // tag took its tuning (grouped under it) with it. Both remaining models
    // read "1 quant · base only".
    await waitFor(() => expect(screen.getAllByText("1 quant · base only")).toHaveLength(2));
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
});
