import "../chat/test/localStorage";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopNav } from "./TopNav";
import { RemudaProvider } from "./state";
import { FakeClient, makeModel } from "./test/FakeClient";

function stubTauriBridge(impl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const invoke = vi.fn(impl);
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
  return invoke;
}

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

/** Renders TopNav with a spilled resident model and opens the popover from
 * whichever chip is present. A spilled split is chosen deliberately: a fully
 * resident model would legitimately show "0 B RAM" (a real reading, not an
 * unavailable one), which would collide with this file's "no 0 B" checks. */
async function renderOpenPopover(client: FakeClient) {
  render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <TopNav />
    </RemudaProvider>,
  );
  const chip = await screen.findByText("2.9 GB GPU + 1.8 GB RAM");
  fireEvent.click(chip);
  return screen.findByRole("dialog", { name: "Runtime" });
}

function spilledClient(options: ConstructorParameters<typeof FakeClient>[0] = {}) {
  return new FakeClient({
    models: [makeModel({ tag: "llama3.1:8b", isLoaded: true, sizeBytes: 4_700_000_000 })],
    running: [
      {
        tag: "llama3.1:8b",
        sizeBytes: 4_700_000_000,
        sizeVramBytes: 2_900_000_000,
        contextLength: 8192,
        expiresAt: null,
      },
    ],
    ...options,
  });
}

describe("RuntimePopover — no Tauri bridge (the default rendering path)", () => {
  it("renders, but omits host memory, CPU and GPU entirely — no 0% or 0 B anywhere", async () => {
    const client = spilledClient();
    const popover = await renderOpenPopover(client);

    expect(screen.queryByText("Host memory")).not.toBeInTheDocument();
    expect(screen.queryByText("Ollama CPU")).not.toBeInTheDocument();
    expect(screen.queryByText("GPU utilisation")).not.toBeInTheDocument();
    expect(screen.queryByText(/unavailable on this machine/)).not.toBeInTheDocument();

    // Model placement still renders — it comes from /api/ps, not the bridge.
    expect(screen.getByText("Model placement")).toBeInTheDocument();
    expect(screen.getByText("2.9 GB GPU · 1.8 GB RAM")).toBeInTheDocument();

    expect(popover.textContent).not.toMatch(/\b0%/);
    expect(popover.textContent).not.toMatch(/\b0 B\b/);
  });

  it("still shows Eject and the keep_alive footer with no bridge present", async () => {
    const client = spilledClient();
    await renderOpenPopover(client);

    expect(screen.getByText("kept")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eject" })).toBeInTheDocument();
  });
});

describe("RuntimePopover — telemetry present", () => {
  it("shows host memory, CPU and the GPU-unavailable note (never a meter) when gpuPercent is null", async () => {
    stubTauriBridge(async (cmd) => {
      if (cmd === "host_stats") {
        return {
          memTotalBytes: 32_000_000_000,
          memUsedBytes: 18_400_000_000,
          ollamaCpuPercent: 4,
          memIsUnified: true,
          gpuPercent: null,
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });
    const client = spilledClient();
    await renderOpenPopover(client);

    await screen.findByText("Host memory");
    expect(screen.getByText("18.4 GB / 32.0 GB")).toBeInTheDocument();
    expect(screen.getByText("Ollama CPU")).toBeInTheDocument();
    expect(screen.getByText("4%")).toBeInTheDocument();

    expect(await screen.findByText("GPU utilisation unavailable on this machine")).toBeInTheDocument();
    expect(screen.queryByText("GPU utilisation")).not.toBeInTheDocument();
    // No occupancy reply yet either, so nothing on this render should have
    // produced a meter at all — a GPU meter pinned at 0% would be exactly
    // the lie SPEC-tuning T7 rules out.
    expect(document.querySelectorAll(".meter")).toHaveLength(0);
  });

  it("never invokes the host bridge while the popover is closed", async () => {
    const invoke = stubTauriBridge(async () => ({
      memTotalBytes: 1,
      memUsedBytes: 1,
      ollamaCpuPercent: 0,
      memIsUnified: true,
      gpuPercent: null,
    }));
    const client = spilledClient();
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
      </RemudaProvider>,
    );

    await screen.findByText("2.9 GB GPU + 1.8 GB RAM");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invoke).not.toHaveBeenCalled();
  });
});
