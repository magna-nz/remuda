/**
 * The lane editor (docs/SPEC-round-two.md R7).
 *
 * The case worth the most tests is the one R7 calls normal rather than
 * special: **the same model under two different Modelfiles**. If the
 * Modelfile is not its own control, and not on the chip, that setup is
 * unbuildable and unreadable.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  LaneEditor,
  laneChipLabel,
  nextLaneChoice,
  type LaneChoice,
  type LaneEditorProps,
} from "./LaneEditor";
import { MAX_LANES, type Lane } from "./types";

const CHOICES: LaneChoice[] = [
  { base: "gemma-4-31b:latest", model: "gemma-4-31b:latest", modelfile: null },
  { base: "gemma-4-31b:latest", model: "gemma-terse:latest", modelfile: "terse-v2" },
  { base: "gemma-4-31b:latest", model: "gemma-warm:latest", modelfile: "warm-v1" },
  { base: "qwen3.8-27b:latest", model: "qwen3.8-27b:latest", modelfile: null },
  { base: "qwen3.8-27b:latest", model: "qwen-terse:latest", modelfile: "terse-v2" },
];

const ONE_LANE: Lane[] = [{ id: "l1", model: "gemma-4-31b:latest", modelfile: null }];

function renderEditor(lanes: Lane[], extra: Partial<LaneEditorProps> = {}) {
  const onChange = vi.fn();
  render(
    <LaneEditor
      lanes={lanes}
      choices={CHOICES}
      onChange={onChange}
      makeLaneId={() => "new-lane"}
      {...extra}
    />,
  );
  return onChange;
}

describe("picking a configuration", () => {
  it("gives each lane a model and a Modelfile, as two controls", () => {
    renderEditor(ONE_LANE);
    const model = screen.getByRole("combobox", { name: "Lane 1 model" }) as HTMLSelectElement;
    const modelfile = screen.getByRole("combobox", {
      name: "Lane 1 Modelfile",
    }) as HTMLSelectElement;
    expect(model.value).toBe("gemma-4-31b:latest");
    // The base model reads as "Original", not as a blank.
    expect(modelfile.value).toBe("");
    expect(Array.from(modelfile.options).map((o) => o.text)).toEqual([
      "Original",
      "terse-v2",
      "warm-v1",
    ]);
  });

  it("swaps in the variant's own tag when a Modelfile is chosen", () => {
    const onChange = renderEditor(ONE_LANE);
    fireEvent.change(screen.getByRole("combobox", { name: "Lane 1 Modelfile" }), {
      target: { value: "terse-v2" },
    });
    // `model` is what Ollama loads, so it becomes the variant's tag;
    // `modelfile` is the display name that goes on the chip.
    expect(onChange).toHaveBeenCalledWith([
      { id: "l1", model: "gemma-terse:latest", modelfile: "terse-v2" },
    ]);
  });

  it("carries a Modelfile across a model change when the new model has one by that name", () => {
    const onChange = renderEditor([
      { id: "l1", model: "gemma-terse:latest", modelfile: "terse-v2" },
    ]);
    fireEvent.change(screen.getByRole("combobox", { name: "Lane 1 model" }), {
      target: { value: "qwen3.8-27b:latest" },
    });
    expect(onChange).toHaveBeenCalledWith([
      { id: "l1", model: "qwen-terse:latest", modelfile: "terse-v2" },
    ]);
  });

  it("falls back to Original when the new model has no such Modelfile", () => {
    const onChange = renderEditor([
      { id: "l1", model: "gemma-warm:latest", modelfile: "warm-v1" },
    ]);
    fireEvent.change(screen.getByRole("combobox", { name: "Lane 1 model" }), {
      target: { value: "qwen3.8-27b:latest" },
    });
    expect(onChange).toHaveBeenCalledWith([
      { id: "l1", model: "qwen3.8-27b:latest", modelfile: null },
    ]);
  });

  it("keeps a lane pointing at a model that is no longer installed", () => {
    // Silently snapping it to somebody else's model would change what the
    // stored runs were run against.
    renderEditor([{ id: "l1", model: "gone:latest", modelfile: null }]);
    const model = screen.getByRole("combobox", { name: "Lane 1 model" }) as HTMLSelectElement;
    expect(model.value).toBe("gone:latest");
  });
});

describe("adding and removing lanes", () => {
  it("adds a lane, defaulting to the same model under a Modelfile nobody is using", () => {
    // The setup R7 calls normal, in one click.
    const onChange = renderEditor(ONE_LANE);
    fireEvent.click(screen.getByRole("button", { name: "Add lane" }));
    expect(onChange).toHaveBeenCalledWith([
      ...ONE_LANE,
      { id: "new-lane", model: "gemma-terse:latest", modelfile: "terse-v2" },
    ]);
  });

  it("removes the lane it was asked to, and keeps the rest in order", () => {
    const lanes: Lane[] = [
      ...ONE_LANE,
      { id: "l2", model: "gemma-terse:latest", modelfile: "terse-v2" },
      { id: "l3", model: "qwen3.8-27b:latest", modelfile: null },
    ];
    const onChange = renderEditor(lanes);
    fireEvent.click(screen.getByRole("button", { name: "Remove lane 2" }));
    expect(onChange).toHaveBeenCalledWith([lanes[0], lanes[2]]);
  });

  it("will not remove the last lane, because there would be nothing to run", () => {
    const onChange = renderEditor(ONE_LANE);
    const remove = screen.getByRole("button", { name: "Remove lane 1" });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("refuses to go past MAX_LANES, and says why", () => {
    const lanes: Lane[] = Array.from({ length: MAX_LANES }, (_, i) => ({
      id: `l${String(i + 1)}`,
      model: CHOICES[i]!.model,
      modelfile: CHOICES[i]!.modelfile,
    }));
    const onChange = renderEditor(lanes);
    const add = screen.getByRole("button", { name: "Add lane" });
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(onChange).not.toHaveBeenCalled();
    expect(add).toHaveAttribute(
      "title",
      "A benchmark holds 4 lanes at most. Each one is a full model load.",
    );
    expect(screen.getByText(/4 of 4 lanes/)).toBeInTheDocument();
  });

  it("freezes every control while a run is in flight", () => {
    renderEditor([...ONE_LANE, { id: "l2", model: "qwen3.8-27b:latest", modelfile: null }], {
      disabled: true,
    });
    expect(screen.getByRole("button", { name: "Add lane" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove lane 2" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Lane 1 model" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Lane 2 Modelfile" })).toBeDisabled();
  });

  it("offers nothing to add when there are no models", () => {
    render(<LaneEditor lanes={ONE_LANE} choices={[]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Add lane" })).toBeDisabled();
  });
});

describe("the two fields, labelled once at the top", () => {
  it("heads the columns Model and Modelfile", () => {
    renderEditor(ONE_LANE);
    // "Modelfile", not "Configuration": it is what the chips, the glossary
    // and the SPEC call this field, and R7 spends "configuration" on the
    // whole lane rather than on half of it.
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("Modelfile")).toBeInTheDocument();
  });

  it("hides those headings from assistive tech, which has the labels already", () => {
    renderEditor(ONE_LANE);
    // Each select carries its own aria-label, so an announced column would
    // repeat the word without adding anything.
    const head = screen.getByText("Model").closest("[aria-hidden]");
    expect(head).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "Lane 1 model" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Lane 1 Modelfile" })).toBeInTheDocument();
  });
});

describe("the chip label", () => {
  it("names the base model and the Modelfile, never the variant tag twice", () => {
    expect(laneChipLabel(ONE_LANE[0]!, CHOICES)).toBe("gemma-4-31b · Original");
    expect(
      laneChipLabel({ id: "l2", model: "qwen-terse:latest", modelfile: "terse-v2" }, CHOICES),
    ).toBe("qwen3.8-27b · terse-v2");
  });

  it("falls back to the lane's own tag when the model is gone", () => {
    expect(laneChipLabel({ id: "l3", model: "gone:latest", modelfile: null }, CHOICES)).toBe(
      "gone · Original",
    );
  });

  /**
   * The shape `migrateBenches` produces: an R4 bench whose model was itself a
   * variant becomes a lane carrying that variant's tag with `modelfile: null`
   * (benchmarks.ts, `benchmarkFromBench`). The tag is what Ollama loads, so
   * reading the null as "Original" credits the base model with answers the
   * variant wrote, which is the one thing this table must never get wrong.
   */
  it("names the Modelfile its model resolves to, not a stale null", () => {
    const migrated: Lane = { id: "from-bench", model: "gemma-terse:latest", modelfile: null };
    expect(laneChipLabel(migrated, CHOICES)).toBe("gemma-4-31b · terse-v2");
  });

  // A variant's Modelfile name is its own tag, so it arrives carrying the
  // `:latest` every other chip in the app drops.
  it("drops :latest from a Modelfile named by its tag", () => {
    const tagged: LaneChoice[] = [
      { base: "gemma-4-31b:latest", model: "gemma-4-31b:latest", modelfile: null },
      {
        base: "gemma-4-31b:latest",
        model: "gemma-coding-q5:latest",
        modelfile: "gemma-coding-q5:latest",
      },
    ];
    const lane: Lane = { id: "l", model: "gemma-coding-q5:latest", modelfile: null };
    expect(laneChipLabel(lane, tagged)).toBe("gemma-4-31b · gemma-coding-q5");
  });
});

describe("a lane whose Modelfile disagrees with its model", () => {
  const migrated: Lane = { id: "from-bench", model: "gemma-terse:latest", modelfile: null };

  it("shows the Modelfile the model actually names", () => {
    renderEditor([migrated]);
    const model = screen.getByRole("combobox", { name: "Lane 1 model" }) as HTMLSelectElement;
    const modelfile = screen.getByRole("combobox", {
      name: "Lane 1 Modelfile",
    }) as HTMLSelectElement;
    expect(model.value).toBe("gemma-4-31b:latest");
    expect(modelfile.value).toBe("terse-v2");
  });

  it("does not offer a tag some lane is already running", () => {
    // The base is taken outright and the migrated lane holds gemma-terse, so
    // the only gemma configuration left to offer is gemma-warm. Matching on
    // the tag alone is what sees the second one as taken.
    const lanes: Lane[] = [{ id: "l1", model: "gemma-4-31b:latest", modelfile: null }, migrated];
    expect(nextLaneChoice(lanes, CHOICES)).toEqual(CHOICES[2]);
  });

  it("carries the resolved Modelfile across a change of model", () => {
    const onChange = renderEditor([migrated]);
    fireEvent.change(screen.getByRole("combobox", { name: "Lane 1 model" }), {
      target: { value: "qwen3.8-27b:latest" },
    });
    expect(onChange).toHaveBeenCalledWith([
      { id: "from-bench", model: "qwen-terse:latest", modelfile: "terse-v2" },
    ]);
  });
});

describe("nextLaneChoice", () => {
  it("prefers an unused Modelfile on the last lane's model", () => {
    expect(nextLaneChoice(ONE_LANE, CHOICES)).toEqual(CHOICES[1]);
  });

  it("moves on once that model's Modelfiles are all taken", () => {
    const lanes: Lane[] = [
      ...ONE_LANE,
      { id: "l2", model: "gemma-terse:latest", modelfile: "terse-v2" },
      { id: "l3", model: "gemma-warm:latest", modelfile: "warm-v1" },
    ];
    expect(nextLaneChoice(lanes, CHOICES)).toEqual(CHOICES[3]);
  });

  it("has nothing to offer with no choices", () => {
    expect(nextLaneChoice(ONE_LANE, [])).toBeNull();
  });
});
