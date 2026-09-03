import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CPU_HISTORY_LENGTH, useHostStats } from "./useHostStats";

function stubTauriBridge(impl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const invoke = vi.fn(impl);
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
  return invoke;
}

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  vi.useRealTimers();
});

describe("useHostStats", () => {
  it("resolves to null with no bridge — the default rendering path", async () => {
    const { result } = renderHook(() => useHostStats(50));

    await waitFor(() => expect(result.current.stats).toBeNull());
    expect(result.current.cpuHistory).toEqual([]);
  });

  it("polls immediately, then again on the given interval, and stops after unmount", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const invoke = stubTauriBridge(async () => {
      calls += 1;
      return { memTotalBytes: 1, memUsedBytes: 1, ollamaCpuPercent: calls, gpuPercent: null };
    });

    const { result, unmount } = renderHook(() => useHostStats(1000));

    await act(async () => {
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    // `waitFor`'s own polling relies on real timers, which fake timers have
    // replaced — the microtask flush above is what actually settles the
    // state, so assert directly rather than reaching for `waitFor` here.
    expect(result.current.stats?.ollamaCpuPercent).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(invoke).toHaveBeenCalledTimes(2);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // Unmounting cleared the interval — no further ticks, ever.
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps a rolling CPU history capped at 60 samples", async () => {
    vi.useFakeTimers();
    let n = 0;
    stubTauriBridge(async () => {
      n += 1;
      return { memTotalBytes: 1, memUsedBytes: 1, ollamaCpuPercent: n, gpuPercent: null };
    });

    const { result } = renderHook(() => useHostStats(10));
    await act(async () => {
      await Promise.resolve();
    });

    for (let i = 0; i < CPU_HISTORY_LENGTH + 10; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
    }

    expect(result.current.cpuHistory.length).toBe(CPU_HISTORY_LENGTH);
    // Oldest-first, so the most recent reading is the last one captured.
    expect(result.current.cpuHistory[CPU_HISTORY_LENGTH - 1]).toBe(n);
  });

  it("preserves a real zero CPU reading rather than dropping it from history", async () => {
    const invoke = stubTauriBridge(async () => ({
      memTotalBytes: 8,
      memUsedBytes: 4,
      ollamaCpuPercent: 0,
      gpuPercent: null,
    }));

    const { result } = renderHook(() => useHostStats(1_000_000));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await waitFor(() => expect(result.current.cpuHistory).toEqual([0]));
  });
});
