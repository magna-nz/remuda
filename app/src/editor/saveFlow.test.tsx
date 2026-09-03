/**
 * Save / Save as… flows (SPEC.md §5.4, §9): "Save as…" creates a new tuned
 * variant then stops the previously loaded model and reloads the new one,
 * in that order; a failed `ollama create` surfaces verbatim and leaves the
 * editor dirty rather than resetting it.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "./EditorView";
import { TopNav } from "../ui/TopNav";
import { RemudaProvider } from "../ui/state";
import { FakeClient, makeModel } from "../ui/test/FakeClient";

const FIXTURE_MODELFILE = `FROM llama3.1:8b\n\nSYSTEM """Be helpful."""\n`;

async function openEditorFor(client: FakeClient) {
  render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <TopNav />
      <EditorView />
    </RemudaProvider>,
  );
  fireEvent.click(await screen.findByLabelText("Edit llama3.1:8b's Modelfile"));
  await screen.findByLabelText("Raw Modelfile");
}

describe("Modelfile editor save flow", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Save as… creates the new name, then unloads the old model before loading the new one", async () => {
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
      modelfile: FIXTURE_MODELFILE,
    });
    const unloadSpy = vi.spyOn(client, "unload");
    const loadSpy = vi.spyOn(client, "load");
    await openEditorFor(client);

    fireEvent.click(screen.getByRole("button", { name: /Save as/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "support-bot-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create & load" }));

    await waitFor(() => expect(client.createCalls).toHaveLength(1));
    expect(client.createCalls[0]!.name).toBe("support-bot-v2:latest");
    // Default selection is "Keep" — no quantize field reaches /api/create.
    expect(client.createCalls[0]!.request.quantize).toBeUndefined();

    await waitFor(() => expect(loadSpy).toHaveBeenCalled());
    expect(unloadSpy).toHaveBeenCalledWith("llama3.1:8b");
    expect(loadSpy).toHaveBeenCalledWith("support-bot-v2:latest", "5m");
    expect(unloadSpy.mock.invocationCallOrder[0]).toBeLessThan(loadSpy.mock.invocationCallOrder[0]!);
  });

  it("Quantisation defaults to Keep, naming the base's inherited level, and sends no quantize field", async () => {
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true, quantization: "Q4_K_M" })],
      modelfile: FIXTURE_MODELFILE,
    });
    await openEditorFor(client);

    fireEvent.click(screen.getByRole("button", { name: /Save as/ }));
    expect(screen.getByRole("button", { name: "Keep · Q4_K_M" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("ollama create <name>", { exact: false })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "support-bot-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create & load" }));

    await waitFor(() => expect(client.createCalls).toHaveLength(1));
    expect(client.createCalls[0]!.request.quantize).toBeUndefined();
  });

  it("picking an explicit quantisation level forwards it verbatim to /api/create and the preview reflects it", async () => {
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true, quantization: "Q4_K_M" })],
      modelfile: FIXTURE_MODELFILE,
    });
    await openEditorFor(client);

    fireEvent.click(screen.getByRole("button", { name: /Save as/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "support-bot-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "q8_0" }));

    expect(screen.getByRole("button", { name: "q8_0" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Keep · Q4_K_M" })).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByText("ollama create support-bot-v2 -q q8_0", { exact: false }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create & load" }));

    await waitFor(() => expect(client.createCalls).toHaveLength(1));
    expect(client.createCalls[0]!.request.quantize).toBe("q8_0");
  });

  it("a failed create surfaces its error verbatim and leaves the editor dirty", async () => {
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
      modelfile: FIXTURE_MODELFILE,
      failCreate: 'Ollama /api/create failed (400): invalid FROM "llama3.1:8b-typo"',
    });
    await openEditorFor(client);

    fireEvent.change(screen.getByLabelText(/System prompt/), { target: { value: "Something new." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('invalid FROM "llama3.1:8b-typo"');

    // The editor is still showing the edit, un-reverted, and Revert is
    // still enabled — nothing was silently discarded or reset.
    expect((screen.getByLabelText(/System prompt/) as HTMLTextAreaElement).value).toBe("Something new.");
    expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled();
    expect(client.unloadCalls).toHaveLength(0);
    expect(client.loadCalls).toHaveLength(0);
  });
});
