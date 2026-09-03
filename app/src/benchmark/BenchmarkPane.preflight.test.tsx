/**
 * The seam: does the memory check actually gate Run, and only when it should?
 *
 * `hostStats` is mocked because a unified-memory reading is the precondition
 * for any prediction at all — without it the honest verdict is "unknown",
 * which is itself one of the cases under test here.
 */
import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../chat/test/localStorage";
import type { HostStats } from "../api/host";

const hostStatsMock = vi.fn(async (): Promise<HostStats | null> => null);
vi.mock("../api/host", () => ({ hostStats: () => hostStatsMock() }));

const { BenchmarkPane } = await import("./BenchmarkPane");
const { RemudaProvider, useRemuda } = await import("../ui/state");
const { FakeClient, makeModel } = await import("../ui/test/FakeClient");
const { BENCHMARK_STORAGE_KEY } = await import("./types");
const { createBenchmark } = await import("./benchmarks");

const GB = 1_000_000_000;

/** A 36 GB Apple Silicon box: 27 GB usable, per fit.ts's documented fraction. */
function unified(): HostStats {
  return {
    memTotalBytes: 36 * GB,
    memUsedBytes: 10 * GB,
    ollamaCpuPercent: 3,
    memIsUnified: true,
    gpuPercent: null,
  } as HostStats;
}

const ARCH = {
  architecture: "llama",
  blockCount: 32,
  headCount: 32,
  headCountKv: 8,
  embeddingLength: 4096,
};

/** A benchmark with one prompt and one lane on `laneModel`, already stored. */
function seed(laneModel: string) {
  const benchmark = createBenchmark("bench", laneModel);
  benchmark.prompts = [{ id: "p1", text: "hello" }];
  window.localStorage.setItem(BENCHMARK_STORAGE_KEY, JSON.stringify([benchmark]));
}

function client(opts: { laneGb: number; residentGb: number | null }) {
  const models = [
    makeModel({ tag: "big:27b", sizeBytes: opts.laneGb * GB, archParams: ARCH, contextLength: 8192 }),
  ];
  if (opts.residentGb !== null) {
    models.push(
      makeModel({ tag: "y:7b", sizeBytes: opts.residentGb * GB, isLoaded: true, archParams: ARCH }),
    );
  }
  return new FakeClient({
    models,
    running:
      opts.residentGb === null
        ? []
        : [
            {
              tag: "y:7b",
              sizeBytes: opts.residentGb * GB,
              sizeVramBytes: opts.residentGb * GB,
              contextLength: 8192,
              expiresAt: "2099-01-01T00:00:00Z",
            },
          ],
  });
}

/**
 * The pane renders the *active* benchmark, and nothing selects one on load —
 * `openBenchmark` is what the rail calls. This stands in for that click.
 */
function OpenFirst() {
  const { benchmarks, activeBenchmarkId, openBenchmark } = useRemuda();
  const first = benchmarks[0]?.id ?? null;
  useEffect(() => {
    if (first !== null && activeBenchmarkId === null) openBenchmark(first);
  }, [first, activeBenchmarkId, openBenchmark]);
  return null;
}

/** Reaches past the disabled button to the store action itself. */
function RunDirectly({ fire }: { fire: boolean }) {
  const { benchmarks, startBenchmarkRun } = useRemuda();
  const id = benchmarks[0]?.id ?? null;
  useEffect(() => {
    if (fire && id !== null) void startBenchmarkRun(id);
  }, [fire, id, startBenchmarkRun]);
  return null;
}

function renderPane(c: InstanceType<typeof FakeClient>) {
  return render(
    <RemudaProvider client={c} pollIntervalMs={1_000_000}>
      <OpenFirst />
      <BenchmarkPane />
    </RemudaProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  hostStatsMock.mockReset();
  hostStatsMock.mockResolvedValue(unified());
});

describe("Run, and the memory check in front of it", () => {
  it("asks before loading when a resident model leaves too little for a lane", async () => {
    seed("big:27b");
    const c = client({ laneGb: 24, residentGb: 5 });
    renderPane(c);

    fireEvent.click(await screen.findByRole("button", { name: "Run all" }));
    await screen.findByRole("dialog", { name: /Unload y:7b to run this\?/ });
    // Nothing has been asked of the server yet — the question comes first.
    expect(c.loadCalls).toHaveLength(0);
  });

  it("runs without asking when the lane fits alongside what is resident", async () => {
    seed("big:27b");
    renderPane(client({ laneGb: 10, residentGb: 5 }));

    fireEvent.click(await screen.findByRole("button", { name: "Run all" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("does not block when the machine's memory cannot be read", async () => {
    // A discrete GPU or no Tauri bridge: no prediction is possible, and an
    // absent prediction is not a failed one.
    hostStatsMock.mockResolvedValue(null);
    seed("big:27b");
    renderPane(client({ laneGb: 24, residentGb: 5 }));

    fireEvent.click(await screen.findByRole("button", { name: "Run all" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("unloads the blocker and runs, and never reloads it afterwards", async () => {
    seed("big:27b");
    const c = client({ laneGb: 24, residentGb: 5 });
    renderPane(c);

    fireEvent.click(await screen.findByRole("button", { name: "Run all" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /Unload and run/ }));

    await waitFor(() => expect(c.unloadCalls).toContain("y:7b"));
    // Matches Eject: the memory is handed back and stays back. The chat that
    // was using y:7b reloads it on its next message, not at the end of a run.
    await waitFor(() => expect(c.loadCalls.map((l) => l.tag)).toContain("big:27b"));
    expect(c.loadCalls.map((l) => l.tag)).not.toContain("y:7b");
  });

  it("refuses an unconfigured lane in the store, not just on the button", async () => {
    // A disabled control is a courtesy; the store is the rule. Without the
    // guard this reaches load("") and records a whole run of error cells.
    seed("");
    const c = client({ laneGb: 24, residentGb: null });
    render(
      <RemudaProvider client={c} pollIntervalMs={1_000_000}>
        <RunDirectly fire />
      </RemudaProvider>,
    );
    await act(async () => {});
    expect(c.loadCalls).toHaveLength(0);
    const saved = JSON.parse(window.localStorage.getItem(BENCHMARK_STORAGE_KEY) ?? "[]");
    expect(saved[0].runs).toHaveLength(0);
  });

  it("refuses to run at all while a lane has no model chosen", async () => {
    seed("");
    renderPane(client({ laneGb: 24, residentGb: null }));
    const run = await screen.findByRole("button", { name: "Run all" });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute("title", "Choose a model for every lane first");
  });
});
