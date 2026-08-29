import "../chat/test/localStorage";
/**
 * The bench store (docs/SPEC-tuning.md T5): capture, the run cap, and the
 * two-tier read of persisted data.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  BENCH_STORAGE_KEY,
  PROSE_CAP,
  RUN_CAP,
  addPrompt,
  appendRun,
  benchSubtitle,
  createBench,
  defaultBenchName,
  latestRun,
  loadBenches,
  previousRun,
  removePrompt,
  runLabel,
  saveBenches,
  trimProse,
  type Bench,
  type BenchRun,
} from "./benches";

function run(overrides: Partial<BenchRun> & { id: string }): BenchRun {
  return {
    ranAt: "2026-08-01T10:00:00.000Z",
    snapshotId: null,
    seed: 4242,
    partial: false,
    results: [],
    ...overrides,
  };
}

function bench(overrides: Partial<Bench> = {}): Bench {
  return {
    id: "b-1",
    name: "Coding voice",
    model: "terse-v2:latest",
    prompts: [],
    runs: [],
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("capture", () => {
  it("adds a prompt with no form in the way", () => {
    const next = addPrompt(bench(), "  Explain a mutex to a Python programmer.  ");
    expect(next.prompts).toHaveLength(1);
    // Trimmed on the way in, so the same prompt pasted with stray
    // whitespace is not a second prompt.
    expect(next.prompts[0]!.text).toBe("Explain a mutex to a Python programmer.");
    expect(next.prompts[0]!.id).not.toBe("");
  });

  it("content-addresses: the same prompt twice adds nothing", () => {
    const first = addPrompt(bench(), "Review this SQL for injection risk.");
    const second = addPrompt(first, "  Review this SQL for injection risk. ");
    // Same reference, so nothing downstream re-renders or re-persists.
    expect(second).toBe(first);
    expect(second.prompts).toHaveLength(1);
  });

  it("blank text is not a prompt", () => {
    const before = bench();
    expect(addPrompt(before, "   \n ")).toBe(before);
  });

  it("removePrompt drops one and leaves the rest alone", () => {
    const two = addPrompt(addPrompt(bench(), "one"), "two");
    const next = removePrompt(two, two.prompts[0]!.id);
    expect(next.prompts.map((p) => p.text)).toEqual(["two"]);
    // A promptId that isn't there is a no-op, not an empty bench.
    expect(removePrompt(two, "nope")).toBe(two);
  });

  it("names a bench after its model when nobody named it", () => {
    expect(defaultBenchName("terse-v2:latest")).toBe("terse-v2 bench");
    expect(createBench(defaultBenchName("mistral:7b"), "mistral:7b").name).toBe("mistral:7b bench");
  });
});

describe("run cap", () => {
  it("keeps the newest RUN_CAP runs and evicts the oldest", () => {
    let b = bench();
    for (let i = 0; i < RUN_CAP + 3; i++) {
      b = appendRun(b, run({ id: `r${i}` }));
    }
    expect(b.runs).toHaveLength(RUN_CAP);
    expect(b.runs[0]!.id).toBe(`r${RUN_CAP + 2}`);
    // r0, r1 and r2 are gone — oldest first, exactly three of them.
    expect(b.runs.map((r) => r.id)).not.toContain("r0");
    expect(b.runs.map((r) => r.id)).not.toContain("r2");
    expect(b.runs[RUN_CAP - 1]!.id).toBe("r3");
  });

  it("stores prose trimmed, marking the cut", () => {
    const long = "x".repeat(PROSE_CAP + 500);
    const b = appendRun(
      bench(),
      run({ id: "r", results: [{ promptId: "p1", content: long, thinking: long }] }),
    );
    expect(b.runs[0]!.results[0]!.content).toBe(`${"x".repeat(PROSE_CAP)}…`);
    expect(b.runs[0]!.results[0]!.thinking).toBe(`${"x".repeat(PROSE_CAP)}…`);
    // Short prose is untouched — no ellipsis on an answer that fitted.
    expect(trimProse("short")).toBe("short");
  });

  it("latestRun and previousRun read the ring newest-first", () => {
    const b = appendRun(appendRun(bench(), run({ id: "old" })), run({ id: "new" }));
    expect(latestRun(b)?.id).toBe("new");
    expect(previousRun(b, "new")?.id).toBe("old");
    // The oldest kept has nothing before it, which is not the same as an error.
    expect(previousRun(b, "old")).toBeNull();
    expect(latestRun(bench())).toBeNull();
  });
});

describe("persistence", () => {
  it("round-trips a bench with runs", () => {
    const b = appendRun(
      addPrompt(bench(), "Explain a mutex."),
      run({
        id: "r1",
        snapshotId: "mf-abc",
        seed: 40412,
        results: [
          { promptId: "p1", content: "A key on a hook.", stats: { evalCount: 12, tokPerSec: 41, ms: 2400 } },
          { promptId: "p2", content: "", error: "context length exceeded" },
        ],
      }),
    );
    saveBenches([b]);
    const [back] = loadBenches();
    expect(back).toEqual(b);
    // The failure survives verbatim — it is the whole reason the row exists.
    expect(back!.runs[0]!.results[1]!.error).toBe("context length exceeded");
  });

  it("degrades to no benches rather than throwing", () => {
    const corrupt = [
      "not json at all",
      "null",
      '"a string"',
      "{}",
      '{"benches":[]}',
      "[[]]",
      "[1,2,3]",
    ];
    for (const payload of corrupt) {
      window.localStorage.setItem(BENCH_STORAGE_KEY, payload);
      expect(() => loadBenches()).not.toThrow();
      expect(loadBenches()).toEqual([]);
    }
  });

  it("drops one unreadable bench without taking the readable ones", () => {
    window.localStorage.setItem(
      BENCH_STORAGE_KEY,
      JSON.stringify([
        { id: "good", name: "Coding voice", model: "m", prompts: [], runs: [] },
        { id: "bad", name: 7, model: "m", prompts: [], runs: [] },
        { id: "worse", name: "x", model: "m", prompts: "not an array", runs: [] },
      ]),
    );
    expect(loadBenches().map((b) => b.id)).toEqual(["good"]);
  });

  it("drops a corrupt prompt by dropping the whole bench", () => {
    // A prompt is the spine: losing one silently would renumber every row
    // and diff answers against the wrong question.
    window.localStorage.setItem(
      BENCH_STORAGE_KEY,
      JSON.stringify([
        { id: "b", name: "x", model: "m", prompts: [{ id: "p1", text: 3 }], runs: [] },
      ]),
    );
    expect(loadBenches()).toEqual([]);
  });

  it("drops a seedless run, alone, and keeps the bench and its other runs", () => {
    window.localStorage.setItem(
      BENCH_STORAGE_KEY,
      JSON.stringify([
        {
          id: "b",
          name: "x",
          model: "m",
          prompts: [{ id: "p1", text: "hi" }],
          runs: [
            { id: "ok", ranAt: "t", snapshotId: null, seed: 1, partial: false, results: [] },
            { id: "seedless", ranAt: "t", snapshotId: null, partial: false, results: [] },
          ],
        },
      ]),
    );
    const [back] = loadBenches();
    expect(back!.prompts).toHaveLength(1);
    expect(back!.runs.map((r) => r.id)).toEqual(["ok"]);
  });

  it("keeps a result whose stats block is rubbish", () => {
    window.localStorage.setItem(
      BENCH_STORAGE_KEY,
      JSON.stringify([
        {
          id: "b",
          name: "x",
          model: "m",
          prompts: [],
          runs: [
            {
              id: "r",
              ranAt: "t",
              snapshotId: null,
              seed: 1,
              partial: false,
              results: [{ promptId: "p1", content: "kept", stats: "nonsense" }],
            },
          ],
        },
      ]),
    );
    const result = loadBenches()[0]!.runs[0]!.results[0]!;
    expect(result.content).toBe("kept");
    expect(result.stats).toBeUndefined();
  });

  it("reads a run whose partial flag did not survive as partial", () => {
    // Under-claim rather than over-claim: a run that may be incomplete must
    // not present itself as a full sweep.
    window.localStorage.setItem(
      BENCH_STORAGE_KEY,
      JSON.stringify([
        {
          id: "b",
          name: "x",
          model: "m",
          prompts: [],
          runs: [{ id: "r", ranAt: "t", snapshotId: null, seed: 1, results: [] }],
        },
      ]),
    );
    expect(loadBenches()[0]!.runs[0]!.partial).toBe(true);
  });
});

describe("labels", () => {
  it("counts prompts and runs for the rail", () => {
    expect(benchSubtitle(bench())).toBe("no prompts yet");
    expect(benchSubtitle(addPrompt(bench(), "one"))).toBe("1 prompt · never run");
    const b = appendRun(addPrompt(addPrompt(bench(), "one"), "two"), run({ id: "r" }));
    expect(benchSubtitle(b)).toBe("2 prompts · 1 run");
  });

  it("numbers runs oldest-to-newest within what is kept", () => {
    const b = appendRun(appendRun(bench(), run({ id: "first" })), run({ id: "second" }));
    expect(runLabel(b, "second")).toBe("run 2");
    expect(runLabel(b, "first")).toBe("run 1");
  });
});
