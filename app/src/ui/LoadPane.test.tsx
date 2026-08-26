import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadPane } from "./LoadPane";
import { TopNav } from "./TopNav";
import { RemudaProvider } from "./state";
import { FakeClient, makeModel } from "./test/FakeClient";

function fixtureModels() {
  return [
    makeModel({ tag: "llama3.1:8b", sizeBytes: 4_700_000_000, quantization: "Q4_K_M" }),
    makeModel({ tag: "mistral:7b", sizeBytes: 4_100_000_000, quantization: "Q4_0" }),
    makeModel({ tag: "support-bot:latest", isVariant: true, base: "llama3.1:8b", sizeBytes: 4_700_000_000 }),
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

describe("LoadPane", () => {
  it("lists all installed models and groups the tuned variant under its base", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openPane(client);

    expect(screen.getByText("llama3.1:8b")).toBeInTheDocument();
    expect(screen.getByText("mistral:7b")).toBeInTheDocument();
    expect(screen.getByText("support-bot:latest")).toBeInTheDocument();
    expect(screen.getByText("tuned")).toBeInTheDocument();

    // llama3.1:8b is the default-selected base, so its Modelfile picker
    // already shows Original + the support-bot variant grouped under it.
    expect(screen.getByText("Original (base)")).toBeInTheDocument();
    expect(screen.getByText("support-bot · tuned")).toBeInTheDocument();
    expect(screen.getByText("＋ New Modelfile")).toBeDisabled();
  });

  it("clicking Load calls client.load with the selected tag and updates the control", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await openPane(client);

    fireEvent.click(screen.getByText("support-bot:latest"));
    expect(screen.getByText("support-bot · tuned")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load model" }));

    await waitFor(() => expect(client.loadCalls).toEqual([{ tag: "support-bot:latest", keepAlive: "5m" }]));
    await waitFor(() => expect(screen.getByText("llama3.1:8b · support-bot")).toBeInTheDocument());
    // The pane auto-closes a moment after a successful load.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 2000 });
  });

  it("surfaces a failed load's error text and keeps the pane open (SPEC §9)", async () => {
    const client = new FakeClient({
      models: fixtureModels(),
      failLoad: 'Ollama /api/generate failed (500): model "llama3.1:8b" busy',
    });
    await openPane(client);

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
    await screen.findByText("mistral:7b");
    // Connection drops after the pane opened with a model list present.
    client.connected = false;
    await waitFor(() => expect(screen.getByRole("button", { name: "Load model" })).toBeDisabled());
  });
});
