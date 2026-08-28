import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineBanner } from "./OfflineBanner";
import { RemudaProvider } from "./state";
import { FakeClient } from "./test/FakeClient";

/** Stand in for the Tauri bridge `startOllama()` (api/host.ts) reaches
 * through. Mirrors api/host.test.ts's stub. */
function stubBridge(impl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const invoke = vi.fn(impl);
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
  return invoke;
}

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

describe("OfflineBanner", () => {
  it("appears when disconnected", async () => {
    const client = new FakeClient({ failVersion: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <OfflineBanner />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Ollama isn’t running.")).toBeInTheDocument();
  });

  it("does not appear once connected", async () => {
    const client = new FakeClient({ connected: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <OfflineBanner />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("surfaces a spawn failure's message verbatim", async () => {
    stubBridge(async () => {
      throw "No such file or directory (os error 2)";
    });
    const client = new FakeClient({ failVersion: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <OfflineBanner />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Start Ollama" }));

    await waitFor(() =>
      expect(screen.getByText("No such file or directory (os error 2)")).toBeInTheDocument(),
    );
    // The real Rust error text, not a generic replacement.
    expect(screen.queryByText(/couldn.t start/i)).not.toBeInTheDocument();
  });

  it("shows a pending state and ignores a double-click while starting", async () => {
    let resolveSpawn: (() => void) | undefined;
    const invoke = stubBridge(
      () =>
        new Promise<null>((resolve) => {
          resolveSpawn = () => resolve(null);
        }),
    );
    const client = new FakeClient({ failVersion: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <OfflineBanner />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const button = screen.getByRole("button", { name: "Start Ollama" });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole("button", { name: /Starting/ })).toBeDisabled());
    expect(invoke).toHaveBeenCalledTimes(1);

    resolveSpawn?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start Ollama" })).not.toBeDisabled(),
    );
  });

  it("clicking Start Ollama outside the desktop shell rejects without an unhandled rejection", async () => {
    // No __TAURI__ bridge stubbed — startOllama() rejects with a
    // "desktop app" message, and the click handler must catch it.
    const client = new FakeClient({ failVersion: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <OfflineBanner />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Start Ollama" }));

    await waitFor(() => expect(screen.getByText(/desktop app/)).toBeInTheDocument());
  });

  it("leaves Retry re-running the health check", async () => {
    const client = new FakeClient({ failVersion: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <OfflineBanner />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    client.connected = true;
    client.failVersion = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
