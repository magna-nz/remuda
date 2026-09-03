import "../chat/test/localStorage";
/**
 * The benchmark store (docs/SPEC-round-two.md R7): editing, the lane cap,
 * the run ring, the two-tier read of persisted data, and the one-way
 * migration from R4's benches.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  addLane,
  addPrompt,
  appendRun,
  benchmarkSubtitle,
  createBenchmark,
  defaultBenchmarkName,
  deleteBenchmark,
  laneLabel,
  latestRun,
  loadBenchmarks,
  migrateBenches,
  migratedBenchmarkId,
  moveLane,
  removeLane,
  removePrompt,
  renameBenchmark,
  runLabel,
  saveBenchmarks,
  trimProse,
  updateLane,
} from "./benchmarks";
import {
  BENCHMARK_STORAGE_KEY,
  LEGACY_BENCH_STORAGE_KEY,
  MAX_LANES,
  PROSE_CAP,
  RUN_CAP,
  type Benchmark,
  type BenchmarkRun,
} from "./types";

function run(overrides: Partial<BenchmarkRun> & { id: string }): BenchmarkRun {
  return {
    ranAt: "2026-08-01T10:00:00.000Z",
    seed: 4242,
    partial: false,
    cells: [],
    ...overrides,
  };
}

function benchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    id: "bm-1",
    name: "Coding voice",
    prompts: [],
    lanes: [{ id: "ln-1", model: "gemma-4-31b:latest", modelfile: null }],
    runs: [],
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("creating and naming", () => {
  it("starts with exactly one lane", () => {
    const created = createBenchmark("Coding voice", "terse-v2:latest", "terse-v2");
    expect(created.lanes).toHaveLength(1);
    expect(created.lanes[0]!.model).toBe("terse-v2:latest");
    expect(created.lanes[0]!.modelfile).toBe("terse-v2");
    expect(created.prompts).toEqual([]);
    expect(created.runs).toEqual([]);
  });

  it("names a benchmark after its model when nobody named it", () => {
    expect(defaultBenchmarkName("gemma-4-31b:latest")).toBe("gemma-4-31b benchmark");
  });

  it("renames, and refuses a blank name", () => {
    const before = benchmark();
    expect(renameBenchmark(before, "  Refusals  ").name).toBe("Refusals");
    expect(renameBenchmark(before, "   ")).toBe(before);
    expect(renameBenchmark(before, "Coding voice")).toBe(before);
  });

  it("deletes by id and leaves the rest alone", () => {
    const list = [benchmark({ id: "a" }), benchmark({ id: "b" })];
    expect(deleteBenchmark(list, "a").map((b) => b.id)).toEqual(["b"]);
    // An id that isn't there is a no-op, not an empty list.
    expect(deleteBenchmark(list, "nope")).toBe(list);
  });
});

describe("prompts", () => {
  it("adds a prompt with no form in the way, trimmed", () => {
    const next = addPrompt(benchmark(), "  Explain a mutex to a Python programmer.  ");
    expect(next.prompts).toHaveLength(1);
    expect(next.prompts[0]!.text).toBe("Explain a mutex to a Python programmer.");
  });

  it("content-addresses: the same prompt twice adds nothing", () => {
    const first = addPrompt(benchmark(), "Review this SQL for injection risk.");
    const second = addPrompt(first, "  Review this SQL for injection risk. ");
    expect(second).toBe(first);
  });

  it("blank text is not a prompt", () => {
    const before = benchmark();
    expect(addPrompt(before, "  \n ")).toBe(before);
  });

  it("removes one and leaves the rest alone", () => {
    const two = addPrompt(addPrompt(benchmark(), "one"), "two");
    expect(removePrompt(two, two.prompts[0]!.id).prompts.map((p) => p.text)).toEqual(["two"]);
    expect(removePrompt(two, "missing")).toBe(two);
  });
});

describe("lanes", () => {
  it("enforces MAX_LANES", () => {
    let b = benchmark();
    for (let i = 0; i < MAX_LANES + 3; i += 1) b = addLane(b, `model-${i}:latest`);
    expect(b.lanes).toHaveLength(MAX_LANES);
    // At the cap the benchmark comes back unchanged — the same reference,
    // so nothing downstream re-renders or re-persists on a refused click.
    expect(addLane(b, "one-more:latest")).toBe(b);
  });

  it("allows the same model twice with different Modelfiles", () => {
    const b = addLane(benchmark(), "gemma-4-31b:latest", "terse-v2");
    expect(b.lanes.map((l) => [l.model, l.modelfile])).toEqual([
      ["gemma-4-31b:latest", null],
      ["gemma-4-31b:latest", "terse-v2"],
    ]);
    expect(b.lanes[0]!.id).not.toBe(b.lanes[1]!.id);
  });

  it("never removes the last lane", () => {
    const one = benchmark();
    expect(removeLane(one, "ln-1")).toBe(one);
    const two = addLane(one, "qwen3.8-27b:latest");
    expect(removeLane(two, "ln-1").lanes.map((l) => l.model)).toEqual(["qwen3.8-27b:latest"]);
    expect(removeLane(two, "missing")).toBe(two);
  });

  it("keeps a removed lane's cells in past runs", () => {
    const two = addLane(benchmark(), "qwen3.8-27b:latest");
    const withRun = appendRun(two, run({
      id: "r1",
      cells: [
        { promptId: "p1", laneId: "ln-1", content: "a" },
        { promptId: "p1", laneId: two.lanes[1]!.id, content: "b" },
      ],
    }));
    const pruned = removeLane(withRun, two.lanes[1]!.id);
    // History is history: the run did happen with that lane in it. rows.ts
    // renders only current lanes, so the cell is invisible, not wrong.
    expect(pruned.runs[0]!.cells).toHaveLength(2);
  });

  it("repoints a lane without changing its id or its place", () => {
    const two = addLane(benchmark(), "qwen3.8-27b:latest");
    const next = updateLane(two, "ln-1", { model: "gemma-4-31b:latest", modelfile: "terse-v2" });
    expect(next.lanes[0]).toEqual({
      id: "ln-1",
      model: "gemma-4-31b:latest",
      modelfile: "terse-v2",
    });
    // A no-op change returns the same reference.
    expect(updateLane(next, "ln-1", { modelfile: "terse-v2" })).toBe(next);
    expect(updateLane(next, "missing", { model: "x" })).toBe(next);
  });

  it("reorders lanes, clamped at both ends", () => {
    let b = benchmark();
    b = addLane(b, "b:latest");
    b = addLane(b, "c:latest");
    const ids = b.lanes.map((l) => l.id);
    expect(moveLane(b, ids[2]!, -1).lanes.map((l) => l.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(moveLane(b, ids[0]!, -1)).toBe(b);
    expect(moveLane(b, ids[2]!, +5)).toBe(b);
    // Moving a lane to the front changes what the diff is *from*.
    expect(moveLane(b, ids[2]!, -9).lanes.map((l) => l.id)).toEqual([ids[2], ids[0], ids[1]]);
  });

  it("labels a lane by model and variant, never by rank", () => {
    expect(laneLabel({ id: "l", model: "gemma-4-31b:latest", modelfile: null })).toBe(
      "gemma-4-31b · Original",
    );
    expect(laneLabel({ id: "l", model: "qwen3.8-27b:latest", modelfile: "terse-v2" })).toBe(
      "qwen3.8-27b · terse-v2",
    );
  });
});

describe("the run ring", () => {
  it("keeps the newest RUN_CAP runs and evicts the oldest", () => {
    let b = benchmark();
    for (let i = 1; i <= RUN_CAP + 3; i += 1) b = appendRun(b, run({ id: `r${i}` }));
    expect(b.runs).toHaveLength(RUN_CAP);
    // Newest first, and the three oldest are gone.
    expect(b.runs[0]!.id).toBe(`r${RUN_CAP + 3}`);
    expect(b.runs.map((r) => r.id)).not.toContain("r1");
    expect(latestRun(b)!.id).toBe(`r${RUN_CAP + 3}`);
    expect(latestRun(benchmark())).toBeNull();
  });

  it("stores prose trimmed, marking the cut", () => {
    const long = "x".repeat(PROSE_CAP + 500);
    const b = appendRun(
      benchmark(),
      run({
        id: "r1",
        cells: [{ promptId: "p1", laneId: "ln-1", content: long, thinking: long }],
      }),
    );
    const cell = b.runs[0]!.cells[0]!;
    expect(cell.content).toHaveLength(PROSE_CAP + 1);
    expect(cell.content.endsWith("…")).toBe(true);
    expect(cell.thinking).toHaveLength(PROSE_CAP + 1);
    expect(trimProse("short")).toBe("short");
  });

  it("keeps an errored cell's cause on the way in", () => {
    const b = appendRun(
      benchmark(),
      run({
        id: "r1",
        cells: [
          { promptId: "p1", laneId: "ln-1", content: "", error: "context length exceeded" },
        ],
      }),
    );
    expect(b.runs[0]!.cells[0]!.error).toBe("context length exceeded");
  });
});

describe("persistence", () => {
  it("round-trips a benchmark with lanes, prompts and runs", () => {
    const b = benchmark({
      prompts: [{ id: "p1", text: "Explain a mutex." }],
      lanes: [
        { id: "ln-1", model: "gemma-4-31b:latest", modelfile: null },
        { id: "ln-2", model: "gemma-4-31b:latest", modelfile: "terse-v2" },
      ],
      runs: [
        run({
          id: "r1",
          cells: [
            {
              promptId: "p1",
              laneId: "ln-1",
              content: "A lock.",
              stats: { evalCount: 12, tokPerSec: 40, ms: 300 },
            },
            { promptId: "p1", laneId: "ln-2", content: "A key on a hook." },
          ],
        }),
      ],
    });
    saveBenchmarks([b]);
    expect(loadBenchmarks()).toEqual([b]);
  });

  it("degrades to no benchmarks rather than throwing on a corrupt payload", () => {
    window.localStorage.setItem(BENCHMARK_STORAGE_KEY, "{not json at all");
    expect(loadBenchmarks()).toEqual([]);
    window.localStorage.setItem(BENCHMARK_STORAGE_KEY, JSON.stringify({ nope: true }));
    expect(loadBenchmarks()).toEqual([]);
    window.localStorage.setItem(BENCHMARK_STORAGE_KEY, JSON.stringify([1, "two", null]));
    expect(loadBenchmarks()).toEqual([]);
  });

  it("nothing stored is no benchmarks, not a throw", () => {
    expect(loadBenchmarks()).toEqual([]);
  });

  it("drops one unreadable benchmark without taking the readable ones", () => {
    window.localStorage.setItem(
      BENCHMARK_STORAGE_KEY,
      JSON.stringify([{ id: "bad", name: "no lanes key", prompts: [], runs: [] }, benchmark()]),
    );
    expect(loadBenchmarks().map((b) => b.id)).toEqual(["bm-1"]);
  });

  it("drops a benchmark whose lanes are corrupt, rather than shifting its columns", () => {
    window.localStorage.setItem(
      BENCHMARK_STORAGE_KEY,
      JSON.stringify([benchmark({ lanes: [{ id: "ln-1" } as never] })]),
    );
    expect(loadBenchmarks()).toEqual([]);
    // A benchmark with no lanes at all has no columns to render either.
    window.localStorage.setItem(BENCHMARK_STORAGE_KEY, JSON.stringify([benchmark({ lanes: [] })]));
    expect(loadBenchmarks()).toEqual([]);
  });

  it("drops a corrupt prompt by dropping the whole benchmark", () => {
    window.localStorage.setItem(
      BENCHMARK_STORAGE_KEY,
      JSON.stringify([benchmark({ prompts: [{ id: "p1" } as never] })]),
    );
    expect(loadBenchmarks()).toEqual([]);
  });

  it("drops a seedless run, alone, and keeps the benchmark", () => {
    window.localStorage.setItem(
      BENCHMARK_STORAGE_KEY,
      JSON.stringify([
        benchmark({
          runs: [
            { id: "r1", ranAt: "t", partial: false, cells: [] } as never,
            run({ id: "r2" }),
          ],
        }),
      ]),
    );
    const loaded = loadBenchmarks();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.runs.map((r) => r.id)).toEqual(["r2"]);
  });

  it("keeps a cell whose stats block is rubbish, and drops a laneless cell", () => {
    window.localStorage.setItem(
      BENCHMARK_STORAGE_KEY,
      JSON.stringify([
        benchmark({
          runs: [
            run({
              id: "r1",
              cells: [
                { promptId: "p1", laneId: "ln-1", content: "kept", stats: "nonsense" } as never,
                { promptId: "p1", content: "no lane" } as never,
              ],
            }),
          ],
        }),
      ]),
    );
    const cells = loadBenchmarks()[0]!.runs[0]!.cells;
    expect(cells).toHaveLength(1);
    expect(cells[0]!.content).toBe("kept");
    expect(cells[0]!.stats).toBeUndefined();
  });

  it("reads a run whose partial flag did not survive as partial", () => {
    window.localStorage.setItem(
      BENCHMARK_STORAGE_KEY,
      JSON.stringify([
        benchmark({ runs: [{ id: "r1", ranAt: "t", seed: 1, cells: [] } as never] }),
      ]),
    );
    // Under-claim rather than over-claim: an unreadable flag must not
    // present a truncated run as a complete one.
    expect(loadBenchmarks()[0]!.runs[0]!.partial).toBe(true);
  });
});

/* -------------------------------------------------------------- migration */

interface LegacyBench {
  id: string;
  name: string;
  model: string;
  prompts: { id: string; text: string }[];
  runs: {
    id: string;
    ranAt: string;
    snapshotId: string | null;
    seed: number;
    partial: boolean;
    results: {
      promptId: string;
      content: string;
      thinking?: string;
      stats?: { evalCount: number; tokPerSec: number | null; ms: number };
      error?: string;
    }[];
  }[];
}

function legacy(): LegacyBench {
  return {
    id: "bench-abc",
    name: "Coding voice",
    model: "terse-v2:latest",
    prompts: [
      { id: "bp-1", text: "Rewrite this loop to bail early." },
      { id: "bp-2", text: "Summarise this stack trace." },
    ],
    runs: [
      {
        id: "br-2",
        ranAt: "2026-08-02T10:00:00.000Z",
        snapshotId: "mf-abc",
        seed: 40412,
        partial: false,
        results: [
          {
            promptId: "bp-1",
            content: "Use break.",
            thinking: "hmm",
            stats: { evalCount: 12, tokPerSec: 40, ms: 300 },
          },
          { promptId: "bp-2", content: "", error: "context length exceeded" },
        ],
      },
      {
        id: "br-1",
        ranAt: "2026-08-01T10:00:00.000Z",
        snapshotId: null,
        seed: 7,
        partial: true,
        results: [{ promptId: "bp-1", content: "Bail with break." }],
      },
    ],
  };
}

describe("migrateBenches", () => {
  it("converts prompts and runs, one lane, nothing dropped", () => {
    window.localStorage.setItem(LEGACY_BENCH_STORAGE_KEY, JSON.stringify([legacy()]));
    const migrated = migrateBenches([]);
    expect(migrated).toHaveLength(1);
    const b = migrated[0]!;
    expect(b.id).toBe(migratedBenchmarkId("bench-abc"));
    expect(b.name).toBe("Coding voice");
    expect(b.prompts).toEqual(legacy().prompts);

    // One lane: the bench's model, no variant.
    expect(b.lanes).toHaveLength(1);
    expect(b.lanes[0]!.model).toBe("terse-v2:latest");
    expect(b.lanes[0]!.modelfile).toBeNull();

    // Both runs survive, newest first, each result now a cell carrying the
    // one lane's id.
    const laneId = b.lanes[0]!.id;
    expect(b.runs.map((r) => r.id)).toEqual(["br-2", "br-1"]);
    expect(b.runs[0]!.seed).toBe(40412);
    expect(b.runs[0]!.partial).toBe(false);
    expect(b.runs[1]!.partial).toBe(true);
    expect(b.runs[0]!.cells).toEqual([
      {
        promptId: "bp-1",
        laneId,
        content: "Use break.",
        thinking: "hmm",
        stats: { evalCount: 12, tokPerSec: 40, ms: 300 },
      },
      // A failure was a result then and is a result now, with its cause.
      { promptId: "bp-2", laneId, content: "", error: "context length exceeded" },
    ]);
    expect(b.runs[1]!.cells).toEqual([
      { promptId: "bp-1", laneId, content: "Bail with break." },
    ]);
  });

  it("is idempotent: running it twice does not duplicate", () => {
    window.localStorage.setItem(LEGACY_BENCH_STORAGE_KEY, JSON.stringify([legacy()]));
    const once = migrateBenches([]);
    const twice = migrateBenches(once);
    // Same reference: nothing to add, so nothing to save either.
    expect(twice).toBe(once);
    expect(twice).toHaveLength(1);
  });

  it("does not overwrite edits made to an already-migrated benchmark", () => {
    window.localStorage.setItem(LEGACY_BENCH_STORAGE_KEY, JSON.stringify([legacy()]));
    const edited = addLane(
      renameBenchmark(migrateBenches([])[0]!, "Renamed by hand"),
      "qwen3.8-27b:latest",
    );
    const after = migrateBenches([edited]);
    expect(after).toEqual([edited]);
  });

  it("leaves the legacy key in place, so a downgrade still finds its data", () => {
    const stored = JSON.stringify([legacy()]);
    window.localStorage.setItem(LEGACY_BENCH_STORAGE_KEY, stored);
    migrateBenches([]);
    expect(window.localStorage.getItem(LEGACY_BENCH_STORAGE_KEY)).toBe(stored);
    // And it does not write the benchmark key either; saving is the caller's.
    expect(window.localStorage.getItem(BENCHMARK_STORAGE_KEY)).toBeNull();
  });

  it("keeps the benchmarks it is given when there is nothing to migrate", () => {
    const existing = [benchmark()];
    expect(migrateBenches(existing)).toBe(existing);
    window.localStorage.setItem(LEGACY_BENCH_STORAGE_KEY, "{not json");
    expect(migrateBenches(existing)).toBe(existing);
    window.localStorage.setItem(LEGACY_BENCH_STORAGE_KEY, JSON.stringify([]));
    expect(migrateBenches(existing)).toBe(existing);
  });

  it("appends migrated benchmarks after the ones already there", () => {
    window.localStorage.setItem(LEGACY_BENCH_STORAGE_KEY, JSON.stringify([legacy()]));
    const existing = [benchmark()];
    expect(migrateBenches(existing).map((b) => b.id)).toEqual([
      "bm-1",
      migratedBenchmarkId("bench-abc"),
    ]);
  });

  it("skips an unreadable bench and migrates the rest", () => {
    window.localStorage.setItem(
      LEGACY_BENCH_STORAGE_KEY,
      JSON.stringify([{ id: "broken" }, legacy(), null, 7]),
    );
    expect(migrateBenches([]).map((b) => b.id)).toEqual([migratedBenchmarkId("bench-abc")]);
  });

  it("caps a bench at R7's lower run cap, keeping the newest", () => {
    const old = legacy();
    old.runs = Array.from({ length: 8 }, (_, i) => ({
      id: `br-${8 - i}`,
      ranAt: "2026-08-01T10:00:00.000Z",
      snapshotId: null,
      seed: 1,
      partial: false,
      results: [],
    }));
    window.localStorage.setItem(LEGACY_BENCH_STORAGE_KEY, JSON.stringify([old]));
    const runs = migrateBenches([])[0]!.runs;
    // R4 kept 8 and R7 keeps 6; the two dropped were the next to be evicted.
    expect(runs).toHaveLength(RUN_CAP);
    expect(runs[0]!.id).toBe("br-8");
  });

  it("survives a round trip through storage unchanged", () => {
    window.localStorage.setItem(LEGACY_BENCH_STORAGE_KEY, JSON.stringify([legacy()]));
    const migrated = migrateBenches([]);
    saveBenchmarks(migrated);
    expect(loadBenchmarks()).toEqual(migrated);
  });
});

describe("labels", () => {
  it("counts prompts, lanes and runs for the rail", () => {
    expect(benchmarkSubtitle(benchmark())).toBe("no prompts yet · 1 lane");
    const one = addPrompt(benchmark(), "one");
    expect(benchmarkSubtitle(one)).toBe("1 prompt · 1 lane · never run");
    const two = addLane(addPrompt(one, "two"), "qwen3.8-27b:latest");
    expect(benchmarkSubtitle(two)).toBe("2 prompts · 2 lanes · never run");
    expect(benchmarkSubtitle(appendRun(two, run({ id: "r1" })))).toBe(
      "2 prompts · 2 lanes · 1 run",
    );
  });

  it("numbers runs oldest-to-newest within what is kept", () => {
    let b = benchmark();
    for (const id of ["r1", "r2", "r3"]) b = appendRun(b, run({ id }));
    expect(runLabel(b, "r3")).toBe("run 3");
    expect(runLabel(b, "r1")).toBe("run 1");
    expect(runLabel(b, "missing")).toBe("run");
  });
});
