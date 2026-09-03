/**
 * The benchmark table (docs/SPEC-round-two.md R7).
 *
 * The rule under test throughout: **different is a diff, never a verdict.**
 * Nothing here ranks a lane, the rows are never reordered, and every state
 * comes from comparing two strings or from a failure.
 */
import { describe, expect, it } from "vitest";
import { addLane, addPrompt, createBenchmark } from "./benchmarks";
import {
  CELL_BADGE,
  ROW_BADGE,
  buildRows,
  cellSnippet,
  cellState,
  formatDuration,
  rowState,
  tally,
  tallyParts,
} from "./rows";
import type { Benchmark, BenchmarkRun, Cell } from "./types";

/** Two lanes ("A" and "B"), then one prompt per text given. */
function twoLanes(...texts: string[]): Benchmark {
  let b = createBenchmark("Coding voice", "A:latest");
  b = addLane(b, "B:latest", "terse-v2");
  for (const text of texts) b = addPrompt(b, text);
  return b;
}

/**
 * A run built from a grid: `cells[promptIndex][laneIndex]`, where `null` is
 * a cell the run never produced.
 */
function runOf(b: Benchmark, grid: (Partial<Cell> | null)[][]): BenchmarkRun {
  const cells: Cell[] = [];
  grid.forEach((row, promptIndex) => {
    row.forEach((entry, laneIndex) => {
      if (entry === null) return;
      cells.push({
        promptId: b.prompts[promptIndex]!.id,
        laneId: b.lanes[laneIndex]!.id,
        content: "",
        ...entry,
      });
    });
  });
  return { id: "r1", ranAt: "2026-08-29T12:00:00.000Z", seed: 1, partial: false, cells };
}

describe("cellState", () => {
  const ok = (content: string): Cell => ({ promptId: "p", laneId: "l", content });

  it("is a diff, not a verdict", () => {
    expect(cellState(ok("same text"), ok("same text"))).toBe("same");
    expect(cellState(ok("terse"), ok("a longer, hedged answer"))).toBe("different");
    // Whichever way round: the state does not change with the length or
    // the quality of the answer, because it knows nothing about either.
    expect(cellState(ok("a longer, hedged answer"), ok("terse"))).toBe("different");
  });

  it("calls a failure an error, and never lets it look like an answer", () => {
    expect(cellState({ promptId: "p", laneId: "l", content: "", error: "boom" }, ok("x"))).toBe(
      "error",
    );
  });

  it("calls a missing cell not run", () => {
    expect(cellState(null, ok("x"))).toBe("pending");
  });

  it("has nothing to compare against when lane 1 is missing or errored", () => {
    // Calling a lane "different" from an absence would be an invented fact.
    expect(cellState(ok("an answer"), null)).toBe("pending");
    expect(cellState(ok("an answer"), { promptId: "p", laneId: "l", content: "", error: "boom" }))
      .toBe("pending");
  });

  it("ignores leading and trailing whitespace, but not interior reflow", () => {
    expect(cellState(ok(" hello world "), ok("hello world"))).toBe("same");
    expect(cellState(ok("hello  world"), ok("hello world"))).toBe("different");
  });
});

describe("buildRows", () => {
  it("is one row per prompt and one cell per lane, in order", () => {
    const b = twoLanes("one", "two");
    const rows = buildRows(
      b,
      runOf(b, [
        [{ content: "a" }, { content: "a" }],
        [{ content: "a" }, { content: "b" }],
      ]),
    );
    expect(rows.map((r) => r.prompt.text)).toEqual(["one", "two"]);
    expect(rows.map((r) => r.number)).toEqual([1, 2]);
    expect(rows[0]!.cells.map((c) => c.lane.id)).toEqual(b.lanes.map((l) => l.id));
    expect(rows[0]!.cells.map((c) => c.state)).toEqual(["baseline", "same"]);
    expect(rows[1]!.cells.map((c) => c.state)).toEqual(["baseline", "different"]);
  });

  it("never reorders: the table is in prompt order and nothing else", () => {
    const b = twoLanes("one", "two", "three", "four");
    const rows = buildRows(
      b,
      runOf(b, [
        [{ content: "a" }, { content: "a" }],
        [{ content: "a" }, { content: "MOVED" }],
        [{ content: "a" }, { content: "a" }],
        [{ content: "a" }, { content: "MOVED" }],
      ]),
    );
    // R4 floated changed rows to the top; a benchmark is read across, so
    // "row 4" must mean the same prompt every run.
    expect(rows.map((r) => r.prompt.text)).toEqual(["one", "two", "three", "four"]);
    expect(rows.map((r) => r.state)).toEqual(["same", "different", "same", "different"]);
  });

  it("names the lanes that differ from lane 1, and only those", () => {
    let b = createBenchmark("three lanes", "A:latest");
    b = addLane(b, "B:latest");
    b = addLane(b, "C:latest");
    b = addPrompt(b, "one");
    const rows = buildRows(
      b,
      runOf(b, [[{ content: "a" }, { content: "a" }, { content: "c" }]]),
    );
    expect(rows[0]!.differing).toEqual([b.lanes[2]!.id]);
    expect(rows[0]!.cells.map((c) => c.state)).toEqual(["baseline", "same", "different"]);
  });

  it("compares against whichever lane is first — reorder and the baseline moves", () => {
    let b = createBenchmark("three lanes", "A:latest");
    b = addLane(b, "B:latest");
    b = addLane(b, "C:latest");
    b = addPrompt(b, "one");
    const run = runOf(b, [[{ content: "a" }, { content: "b" }, { content: "b" }]]);
    expect(buildRows(b, run)[0]!.differing).toEqual([b.lanes[1]!.id, b.lanes[2]!.id]);
    // Same run, lane B first: now it is A that stands out. Neither reading
    // is a judgement — both are "differs from the one on the left".
    const reordered: Benchmark = { ...b, lanes: [b.lanes[1]!, b.lanes[0]!, b.lanes[2]!] };
    expect(buildRows(reordered, run)[0]!.differing).toEqual([b.lanes[0]!.id]);
  });

  it("keeps an errored cell visible with its cause", () => {
    const b = twoLanes("one");
    const rows = buildRows(
      b,
      runOf(b, [[{ content: "a" }, { content: "", error: "context length exceeded" }]]),
    );
    expect(rows[0]!.cells[1]!.state).toBe("error");
    expect(rows[0]!.cells[1]!.cell!.error).toBe("context length exceeded");
    expect(rows[0]!.state).toBe("error");
    // An error is not a difference: it is the absence of an answer to diff.
    expect(rows[0]!.differing).toEqual([]);
  });

  it("a benchmark that has never run is all rows, all not run", () => {
    const b = twoLanes("one", "two");
    const rows = buildRows(b, null);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.cells.every((c) => c.cell === null))).toBe(true);
    expect(tally(rows)).toEqual({ different: 0, same: 0, error: 0, pending: 2, single: 0 });
  });

  it("a cancelled run keeps its finished cells and shows the rest as not run", () => {
    const b = twoLanes("one", "two", "three");
    const rows = buildRows(
      b,
      runOf(b, [
        [{ content: "a" }, { content: "a" }],
        [{ content: "a" }, { content: "b" }],
        [{ content: "a" }, null],
      ]),
    );
    expect(rows[2]!.cells.map((c) => c.state)).toEqual(["baseline", "pending"]);
    expect(tally(rows)).toEqual({ different: 1, same: 1, error: 0, pending: 1, single: 0 });
  });

  it("a lane added after the run has no cells, rather than wrong ones", () => {
    const b = twoLanes("one");
    const run = runOf(b, [[{ content: "a" }, { content: "a" }]]);
    const widened = addLane(b, "C:latest");
    const cells = buildRows(widened, run)[0]!.cells;
    expect(cells).toHaveLength(3);
    expect(cells[2]!.cell).toBeNull();
    expect(cells[2]!.state).toBe("pending");
  });

  it("ignores cells belonging to a lane that has since been removed", () => {
    const b = twoLanes("one");
    const run = runOf(b, [[{ content: "a" }, { content: "b" }]]);
    const narrowed: Benchmark = { ...b, lanes: [b.lanes[0]!] };
    const row = buildRows(narrowed, run)[0]!;
    expect(row.cells).toHaveLength(1);
    expect(row.state).toBe("single");
  });
});

describe("rowState", () => {
  const cell = (content: string): Cell => ({ promptId: "p", laneId: "l", content });

  it("calls one lane 'single', because there was nothing to compare it with", () => {
    const b = createBenchmark("one lane", "A:latest");
    const withPrompt = addPrompt(b, "one");
    const rows = buildRows(withPrompt, runOf(withPrompt, [[{ content: "a" }]]));
    // A migrated R4 bench is exactly this shape. "Same" would claim an
    // agreement that was never tested.
    expect(rows[0]!.state).toBe("single");
    expect(tally(rows)).toEqual({ different: 0, same: 0, error: 0, pending: 0, single: 1 });
  });

  it("lets an error outrank a gap, and a gap outrank a difference", () => {
    const lane = { id: "l", model: "m", modelfile: null };
    const failed = { lane, cell: { promptId: "p", laneId: "l", content: "", error: "x" }, state: "error" as const };
    const gap = { lane, cell: null, state: "pending" as const };
    const differs = { lane, cell: cell("b"), state: "different" as const };
    const base = { lane, cell: cell("a"), state: "baseline" as const };
    expect(rowState([base, differs, failed])).toBe("error");
    expect(rowState([base, differs, gap])).toBe("pending");
    expect(rowState([base, differs])).toBe("different");
    expect(rowState([base, { lane, cell: cell("a"), state: "same" as const }])).toBe("same");
    expect(rowState([])).toBe("pending");
  });
});

describe("the tally strip", () => {
  it("skips every zero and pluralises errors", () => {
    expect(
      tallyParts({ different: 2, same: 3, error: 1, pending: 0, single: 0 }).map((p) => p.label),
    ).toEqual(["2 different", "3 same", "1 error"]);
    expect(
      tallyParts({ different: 0, same: 0, error: 2, pending: 4, single: 1 }).map((p) => p.label),
    ).toEqual(["2 errors", "4 not run", "1 answered"]);
    expect(tallyParts({ different: 0, same: 0, error: 0, pending: 0, single: 0 })).toEqual([]);
  });

  it("badges by state and never by quality", () => {
    expect(ROW_BADGE).toEqual({
      different: "Different",
      same: "Same",
      error: "Error",
      pending: "Not run",
      single: "Answered",
    });
    expect(CELL_BADGE).toEqual({
      baseline: "Lane 1",
      same: "Same",
      different: "Different",
      error: "Error",
      pending: "Not run",
    });
  });
});

describe("cell presentation", () => {
  it("shows an em dash where there is no timing to show", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration({ promptId: "p", laneId: "l", content: "", error: "boom" })).toBe("—");
    expect(formatDuration({ promptId: "p", laneId: "l", content: "x" })).toBe("—");
    expect(
      formatDuration({
        promptId: "p",
        laneId: "l",
        content: "x",
        stats: { evalCount: 1, tokPerSec: 1, ms: 2400 },
      }),
    ).toBe("2.4 s");
    expect(
      formatDuration({
        promptId: "p",
        laneId: "l",
        content: "x",
        stats: { evalCount: 1, tokPerSec: 1, ms: 41200 },
      }),
    ).toBe("41 s");
  });

  it("previews the failure, not a blank, on an errored cell", () => {
    expect(cellSnippet({ promptId: "p", laneId: "l", content: "", error: "context length exceeded" }))
      .toBe("context length exceeded");
  });

  it("flattens the answer to one line, and says so when there isn't one", () => {
    expect(cellSnippet({ promptId: "p", laneId: "l", content: "  first line\n\nsecond  line " }))
      .toBe("first line second line");
    expect(cellSnippet({ promptId: "p", laneId: "l", content: "   " })).toBe("(empty answer)");
    expect(cellSnippet(null)).toBe("not run");
  });
});
