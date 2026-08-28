import "../chat/test/localStorage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopNav } from "./TopNav";
import { RemudaProvider, useRemuda } from "./state";
import type { RemudaContextValue } from "./state";
import { FakeClient, makeModel } from "./test/FakeClient";

/** Grabs the live context so a test can drive `sendMessage`/`newChat` directly. */
function Capture({ seen }: { seen: { current: RemudaContextValue | null } }) {
  seen.current = useRemuda();
  return null;
}

function stubTauriBridge(impl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const invoke = vi.fn(impl);
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
  return invoke;
}

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

describe("TopNav", () => {
  it("shows disconnected state when version() fails", async () => {
    const client = new FakeClient({ failVersion: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByText("Not running")).toBeInTheDocument());
    expect(screen.getByText("No model loaded")).toBeInTheDocument();
  });

  it("shows plain Connected (no vnull) when connected but version is null", async () => {
    const client = new FakeClient({ connected: true, version: null });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
    expect(screen.queryByText(/vnull/)).not.toBeInTheDocument();
  });

  it("labels a fully resident model 'all on GPU', never '100% GPU' (SPEC-tuning T7)", async () => {
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true, sizeBytes: 4_700_000_000 })],
      running: [
        {
          tag: "llama3.1:8b",
          sizeBytes: 4_700_000_000,
          sizeVramBytes: 4_700_000_000,
          contextLength: 8192,
          expiresAt: null,
        },
      ],
    });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
      </RemudaProvider>,
    );

    const chip = await screen.findByText("all on GPU · 4.7 GB");
    expect(chip).toHaveClass("rchip", "good");
    expect(screen.queryByText(/100% GPU/)).not.toBeInTheDocument();
    expect(screen.queryByText(/% GPU/)).not.toBeInTheDocument();
  });

  it("shows the VRAM/RAM split in amber when the loaded model spills to CPU", async () => {
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true, sizeBytes: 4_700_000_000 })],
      running: [
        {
          tag: "llama3.1:8b",
          sizeBytes: 4_700_000_000,
          sizeVramBytes: 3_000_000_000,
          contextLength: 8192,
          expiresAt: null,
        },
      ],
    });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
      </RemudaProvider>,
    );

    const chip = await screen.findByText("3.0 GB GPU + 1.7 GB RAM");
    expect(chip).toHaveClass("rchip", "warn");
    expect(screen.queryByText(/100% GPU/)).not.toBeInTheDocument();
  });

  it("omits every runtime chip when nothing is loaded", async () => {
    const client = new FakeClient({ models: [] });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByText("No model loaded")).toBeInTheDocument());
    expect(screen.queryByText(/% GPU/)).not.toBeInTheDocument();
    expect(document.querySelector(".rchip")).not.toBeInTheDocument();
  });

  it("shows the context window alone before any reply, then used/window after one, and goes amber past ~90%", async () => {
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
      running: [
        { tag: "llama3.1:8b", sizeBytes: 4_700_000_000, sizeVramBytes: 4_700_000_000, contextLength: 8192, expiresAt: null },
      ],
      chatChunks: [
        { content: "hi", done: true, stats: { evalCount: 104, evalDurationNs: 1, promptEvalCount: 3000 } },
      ],
    });
    const seen: { current: RemudaContextValue | null } = { current: null };
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
        <Capture seen={seen} />
      </RemudaProvider>,
    );

    await waitFor(() => expect(seen.current?.activeModel?.variant).toBe("llama3.1:8b"));
    // No reply yet — occupancy is unknown, so the chip names only the window.
    expect(await screen.findByText("ctx 8,192")).toBeInTheDocument();

    act(() => seen.current?.newChat());
    await act(async () => {
      await seen.current?.sendMessage("hello");
    });

    // promptEvalCount (3000) + evalCount (104) = 3104, well under 90%.
    const green = await screen.findByText("ctx 3,104/8,192");
    expect(green).not.toHaveClass("warn");

    // A second reply pushes occupancy past the ~90% threshold.
    client.chatChunks = [
      { content: "hi", done: true, stats: { evalCount: 740, evalDurationNs: 1, promptEvalCount: 7000 } },
    ];
    await act(async () => {
      await seen.current?.sendMessage("again");
    });

    const amber = await screen.findByText("ctx 7,740/8,192");
    expect(amber).toHaveClass("rchip", "warn");
  });

  it("ticks the keep_alive countdown once a second and floors at zero", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const client = new FakeClient({
        models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
        running: [
          {
            tag: "llama3.1:8b",
            sizeBytes: 4_700_000_000,
            sizeVramBytes: 4_700_000_000,
            contextLength: 8192,
            expiresAt: "2026-01-01T00:00:05.000Z",
          },
        ],
      });
      render(
        <RemudaProvider client={client} pollIntervalMs={1_000_000}>
          <TopNav />
        </RemudaProvider>,
      );

      // `findByText`/`waitFor` poll on real timers, which fake timers have
      // replaced — flush the provider's initial fetch with `act` instead.
      await act(async () => {});
      expect(screen.getByText("0:05")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText("0:03")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByText("0:00")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never polls host telemetry while the Runtime popover is closed, and does once it opens", async () => {
    const invoke = stubTauriBridge(async (cmd) => {
      if (cmd === "host_stats") {
        return { memTotalBytes: 32_000_000_000, memUsedBytes: 18_400_000_000, ollamaCpuPercent: 4, gpuPercent: null };
      }
      throw new Error(`unexpected command ${cmd}`);
    });
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true, sizeBytes: 4_700_000_000 })],
      running: [
        {
          tag: "llama3.1:8b",
          sizeBytes: 4_700_000_000,
          sizeVramBytes: 4_700_000_000,
          contextLength: 8192,
          expiresAt: null,
        },
      ],
    });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
      </RemudaProvider>,
    );

    const chip = await screen.findByText("all on GPU · 4.7 GB");
    // Give any stray timer a chance to fire before the popover ever opens.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.click(chip);
    await screen.findByRole("dialog", { name: "Runtime" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("host_stats"));
  });
});
