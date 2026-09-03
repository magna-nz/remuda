import "../chat/test/localStorage";
/**
 * Benchmark, on screen (docs/SPEC-round-two.md R7): the table of prompts by
 * lanes, a row expanding to the word diff, an errored cell that keeps its
 * cause, the loading line that makes a lane change visible, the pane help,
 * and the empty state that answers "what *is* a benchmark".
 *
 * Rendered directly with fixture data. The store does not exist yet, so
 * there is no provider here on purpose.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BenchmarkView, type LiveBenchmarkRun } from "./BenchmarkView";
import type { LaneChoice } from "./LaneEditor";
import type { Benchmark, Cell, Lane } from "./types";

const CHOICES: LaneChoice[] = [
  { base: "gemma-4-31b:latest", model: "gemma-4-31b:latest", modelfile: null },
  { base: "gemma-4-31b:latest", model: "gemma-terse:latest", modelfile: "terse-v2" },
  { base: "qwen3.8-27b:latest", model: "qwen3.8-27b:latest", modelfile: null },
  { base: "qwen3.8-27b:latest", model: "qwen-terse:latest", modelfile: "terse-v2" },
];

const LANES: Lane[] = [
  { id: "lane-1", model: "gemma-4-31b:latest", modelfile: null },
  { id: "lane-2", model: "qwen3.8-27b:latest", modelfile: null },
];

const PROMPTS = [
  { id: "p1", text: "Summarise this stack trace." },
  { id: "p2", text: "Rewrite this loop to bail early." },
  { id: "p3", text: "Explain a mutex to a Python programmer." },
];

const CTX_ERROR = "context length exceeded, prompt is 34102 tokens, num_ctx is 26624";

const CELLS: Cell[] = [
  { promptId: "p1", laneId: "lane-1", content: "It dereferenced a null body." },
  { promptId: "p1", laneId: "lane-2", content: "It dereferenced a null body." },
  {
    promptId: "p2",
    laneId: "lane-1",
    content: "Use break once seen has the id, because the rest cannot matter.",
    stats: { evalCount: 12, tokPerSec: 41, ms: 300 },
  },
  {
    promptId: "p2",
    laneId: "lane-2",
    content: "Use break once seen has the id, because nothing else matters.",
  },
  { promptId: "p3", laneId: "lane-1", content: "A single key on a hook by the door." },
  { promptId: "p3", laneId: "lane-2", content: "", error: CTX_ERROR },
];

function makeBenchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    id: "bm-1",
    name: "Coding voice",
    prompts: PROMPTS,
    lanes: LANES,
    runs: [
      {
        id: "r1",
        ranAt: "2026-08-01T10:00:00.000Z",
        seed: 4242,
        partial: false,
        cells: CELLS,
      },
    ],
    ...overrides,
  };
}

function renderView(
  benchmark: Benchmark | null,
  live: LiveBenchmarkRun | null = null,
  extra: Partial<React.ComponentProps<typeof BenchmarkView>> = {},
) {
  return render(
    <BenchmarkView
      benchmark={benchmark}
      live={live}
      choices={CHOICES}
      onRunAll={() => {}}
      onCancel={() => {}}
      onLanesChange={() => {}}
      {...extra}
    />,
  );
}

/** The table itself, without the help strip or the lane editor in the way. */
function table(): HTMLElement {
  const el = document.querySelector(".benchmark");
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("the table", () => {
  it("is one row per prompt and one column per lane", () => {
    renderView(makeBenchmark());

    const rows = within(table()).getAllByRole("button", { expanded: false });
    expect(rows).toHaveLength(3);
    // Prompt order, always. p2 is the row that differs and p3 the one that
    // errored, and neither is floated to the top: sorting by anything but
    // the prompts would be a ranking.
    expect(rows[0]!.textContent).toContain("Summarise this stack trace.");
    expect(rows[1]!.textContent).toContain("Rewrite this loop to bail early.");
    expect(rows[2]!.textContent).toContain("Explain a mutex to a Python programmer.");

    // One column per lane, once a row is open.
    fireEvent.click(rows[1]!);
    const columns = table().querySelectorAll(".bcol");
    expect(columns).toHaveLength(2);
    expect(columns[0]!.textContent).toContain("Lane 1 · gemma-4-31b · Original");
    expect(columns[1]!.textContent).toContain("Lane 2 · qwen3.8-27b · Original");
  });

  it("names each lane's configuration as a chip in the header", () => {
    renderView(makeBenchmark());
    const head = document.querySelector(".benchhead") as HTMLElement;
    const chips = Array.from(head.querySelectorAll(".lanechip")).map((c) => c.textContent);
    expect(chips).toEqual(["gemma-4-31b · Original", "qwen3.8-27b · Original"]);
    expect(within(head).getByText("3 prompts")).toBeInTheDocument();
  });

  it("shows the same model under two Modelfiles as two distinct chips", () => {
    // The setup R7 calls normal: one model, two Modelfiles. The chip has to
    // carry the Modelfile, because the model alone cannot tell them apart.
    renderView(
      makeBenchmark({
        lanes: [
          { id: "lane-1", model: "gemma-4-31b:latest", modelfile: null },
          { id: "lane-2", model: "gemma-terse:latest", modelfile: "terse-v2" },
        ],
        runs: [],
      }),
    );
    const chips = Array.from(document.querySelectorAll(".benchhead .lanechip")).map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(["gemma-4-31b · Original", "gemma-4-31b · terse-v2"]);
  });

  it("counts what differs without scoring anything", () => {
    renderView(makeBenchmark());
    const tally = document.querySelector(".btally") as HTMLElement;
    expect(within(tally).getByText("1 different")).toBeInTheDocument();
    expect(within(tally).getByText("1 same")).toBeInTheDocument();
    expect(within(tally).getByText("1 error")).toBeInTheDocument();
    // Every badge is a statement about the text, never a rank. There is no
    // "better", no star and no score anywhere in the vocabulary.
    const badges = Array.from(table().querySelectorAll(".bbadge")).map((b) => b.textContent);
    expect(new Set(badges)).toEqual(new Set(["Same", "Different", "Error"]));
  });

  it("rows are collapsed until asked, and expand to the lanes word-diffed", () => {
    renderView(makeBenchmark());
    expect(table().querySelector(".bcol")).toBeNull();

    fireEvent.click(within(table()).getAllByRole("button", { expanded: false })[1]!);

    // Lane 2 against lane 1, the words that moved and only those. "because"
    // is common to both answers, so it is not marked.
    const del = table().querySelector(".bcol-b del") as HTMLElement;
    const ins = table().querySelector(".bcol-b ins") as HTMLElement;
    expect(del.textContent).toContain("the rest cannot matter.");
    expect(ins.textContent).toContain("nothing else matters.");
    expect(del.textContent).not.toContain("because");
    // The first lane is the reference the others are measured against.
    expect(table().querySelectorAll(".bcol")[0]!.textContent).toContain("the reference");
    expect(table().querySelectorAll(".bcol")[1]!.textContent).toContain("Different");
    // Stats ride along with the cell that reported them.
    expect(table().querySelector(".bfoot")!.textContent).toContain("41 tok/s");
  });

  it("diffs every lane past the first against the first, not against each other", () => {
    const lanes: Lane[] = [
      ...LANES,
      { id: "lane-3", model: "qwen-terse:latest", modelfile: "terse-v2" },
    ];
    renderView(
      makeBenchmark({
        lanes,
        prompts: [PROMPTS[1]!],
        runs: [
          {
            id: "r1",
            ranAt: "2026-08-01T10:00:00.000Z",
            seed: 7,
            partial: false,
            cells: [
              { promptId: "p2", laneId: "lane-1", content: "one two three" },
              { promptId: "p2", laneId: "lane-2", content: "one two four" },
              { promptId: "p2", laneId: "lane-3", content: "one two five" },
            ],
          },
        ],
      }),
    );
    fireEvent.click(within(table()).getAllByRole("button", { expanded: false })[0]!);
    const columns = table().querySelectorAll(".bcol");
    expect(columns).toHaveLength(3);
    // The reference column carries no markup: it cannot be marked up two
    // different ways at once, so it is left as it was written.
    expect(columns[0]!.querySelector("ins")).toBeNull();
    expect(columns[0]!.querySelector("del")).toBeNull();
    expect(columns[1]!.querySelector("ins")!.textContent).toContain("four");
    expect(columns[2]!.querySelector("ins")!.textContent).toContain("five");
  });

  it("keeps an errored cell on screen with its cause", () => {
    renderView(makeBenchmark());
    const rows = within(table()).getAllByRole("button", { expanded: false });
    // Visible collapsed, so the failure is not something you have to open
    // the row to discover.
    expect(rows[2]!.querySelector(".sn.err")!.textContent).toContain("context length exceeded");
    expect(rows[2]!.textContent).toContain("Error");

    fireEvent.click(rows[2]!);
    // And verbatim once open, beside the lane that did answer.
    expect(table().querySelector(".bcol-err")!.textContent).toBe(CTX_ERROR);
    expect(table().querySelectorAll(".bcol")[0]!.textContent).toContain(
      "A single key on a hook by the door.",
    );
  });

  it("keeps whatever an errored lane managed before it stopped", () => {
    renderView(
      makeBenchmark({
        prompts: [PROMPTS[0]!],
        runs: [
          {
            id: "r1",
            ranAt: "2026-08-01T10:00:00.000Z",
            seed: 7,
            partial: false,
            cells: [
              { promptId: "p1", laneId: "lane-1", content: "fine" },
              { promptId: "p1", laneId: "lane-2", content: "half an ans", error: "stream ended" },
            ],
          },
        ],
      }),
    );
    fireEvent.click(within(table()).getAllByRole("button", { expanded: false })[0]!);
    expect(table().querySelector(".bcol-part")!.textContent).toBe("half an ans");
  });

  it("names the seed the run was pinned to", () => {
    renderView(makeBenchmark());
    expect((document.querySelector(".runbar") as HTMLElement).textContent).toContain("seed 4242");
  });

  it("says so when nothing has run yet", () => {
    renderView(makeBenchmark({ runs: [] }));
    const runbar = document.querySelector(".runbar") as HTMLElement;
    expect(runbar.textContent).toMatch(/Never run\./);
    expect(within(table()).getAllByText("Not run")).toHaveLength(3);
  });
});

describe("a run in flight", () => {
  const live: LiveBenchmarkRun = {
    seed: 4242,
    cells: CELLS.slice(0, 3),
    progress: {
      phase: "loading",
      lane: LANES[1]!,
      laneNumber: 2,
      laneCount: 2,
      prompt: null,
      done: 3,
      total: 6,
    },
  };

  it("says which model is loading and which lane it is for", () => {
    renderView(makeBenchmark(), live);
    // The honest cost of the feature, shown rather than hidden: a 20 GB lane
    // change is a minute of nothing, and a UI that looks hung is the failure
    // mode this line exists to prevent.
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Loading qwen3.8-27b (lane 2 of 2)");
    expect(status.textContent).toContain("seed 4242");
  });

  it("keeps counting once the lane is loaded and answering", () => {
    renderView(makeBenchmark(), {
      ...live,
      progress: { ...live.progress!, phase: "answering", prompt: PROMPTS[0]! },
    });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Answering on qwen3.8-27b (lane 2 of 2)");
    expect(status.textContent).toContain("3 of 6 answers");
  });

  it("says something before the runner's first report", () => {
    // The gap between pressing Run all and the first onProgress tick is
    // still a gap, and a blank bar in it looks exactly like a hang.
    renderView(makeBenchmark(), { ...live, progress: null });
    expect(screen.getByRole("status").textContent).toContain("Starting the run");
  });

  it("offers Cancel instead of Run all, and freezes the lane editor", () => {
    renderView(makeBenchmark(), live);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run all" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add lane" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Lane 1 model" })).toBeDisabled();
  });

  it("fills the table in as cells settle rather than staying blank", () => {
    renderView(makeBenchmark(), live);
    const rows = within(table()).getAllByRole("button", { expanded: false });
    // Both lanes answered prompt 1, so it can already be compared.
    expect(rows[0]!.textContent).toContain("Same");
    expect(rows[0]!.textContent).toContain("It dereferenced a null body.");
    // Lane 2 has not reached prompts 2 and 3: a gap is not a difference.
    expect(rows[1]!.textContent).toContain("Not run");
    expect(rows[2]!.textContent).toContain("Not run");
  });
});

describe("Run all", () => {
  it("runs, and refuses while something else is generating", () => {
    const onRunAll = vi.fn();
    const { rerender } = renderView(makeBenchmark(), null, { onRunAll });
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    expect(onRunAll).toHaveBeenCalledTimes(1);

    // SPEC §8 is one generation at a time, app-wide. A control left enabled
    // through a refusal is a dead button.
    rerender(
      <BenchmarkView
        benchmark={makeBenchmark()}
        live={null}
        choices={CHOICES}
        elsewhereBusy
        onRunAll={onRunAll}
        onCancel={() => {}}
        onLanesChange={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Run all" })).toBeDisabled();
  });

  it("has nothing to press with no prompts", () => {
    renderView(makeBenchmark({ prompts: [], runs: [] }));
    expect(screen.getByRole("button", { name: "Run all" })).toBeDisabled();
  });
});

describe("pane help", () => {
  it("carries a ? and an explainer that is open on first sight", () => {
    renderView(makeBenchmark());
    const toggle = screen.getByRole("button", { name: "About benchmarks" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const strip = document.getElementById("panehelp-benchmark") as HTMLElement;
    expect(strip).not.toBeNull();
    expect(within(strip).getAllByRole("listitem")).toHaveLength(3);
    // The rule the whole surface is built around, said in the help too.
    expect(strip.textContent).toContain("Different is a diff, not a verdict.");
    // The three words a newcomer will not have: all three are glossary
    // triggers, not bare prose.
    expect(within(strip).getByRole("button", { name: "seed" })).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: "Modelfile" })).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(document.getElementById("panehelp-benchmark")).toBeNull();
  });

  it("puts the seed behind a definition on the run bar as well", () => {
    renderView(makeBenchmark());
    const runbar = document.querySelector(".runbar") as HTMLElement;
    expect(within(runbar).getByRole("button", { name: "seed" })).toBeInTheDocument();
  });
});

describe("the empty state", () => {
  it("says what a benchmark is, why, and the three steps to fill it", () => {
    renderView(makeBenchmark({ prompts: [], runs: [] }));
    const empty = document.querySelector(".emptyfeat") as HTMLElement;
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain(
      "benchmark runs one set of prompts through several models side by side",
    );
    expect(empty.textContent).toContain("Each lane is one configuration");

    const steps = within(empty).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]!.textContent).toContain("Set up the lanes");
    expect(steps[1]!.textContent).toContain("Add to benchmark");
    expect(steps[2]!.textContent).toContain("Run all");
    expect(empty.textContent).toContain(
      "It never scores them, and it never says which lane won.",
    );
  });

  it("still offers the lane editor, because that is step one", () => {
    renderView(makeBenchmark({ prompts: [], runs: [] }));
    expect(screen.getByRole("combobox", { name: "Lane 1 model" })).toBeInTheDocument();
  });
});

describe("no benchmark open", () => {
  it("says so rather than rendering an empty table", () => {
    renderView(null);
    expect(screen.getByText(/No benchmark is open/)).toBeInTheDocument();
    expect(document.querySelector(".benchmark")).toBeNull();
  });
});

describe("prompts", () => {
  it("removes one when the caller offers a way to", () => {
    const onRemovePrompt = vi.fn();
    renderView(makeBenchmark(), null, { onRemovePrompt });
    fireEvent.click(screen.getByRole("button", { name: "Remove prompt 2" }));
    expect(onRemovePrompt).toHaveBeenCalledWith("p2");
  });

  it("offers no remove control when the caller has no handler", () => {
    renderView(makeBenchmark());
    expect(screen.queryByRole("button", { name: "Remove prompt 2" })).toBeNull();
  });
});
