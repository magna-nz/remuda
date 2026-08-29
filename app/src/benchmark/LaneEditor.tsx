/**
 * The lane editor (docs/SPEC-round-two.md R7).
 *
 * A lane is one configuration under test, and the editor's whole job is that
 * **the same model with two different Modelfiles is a normal setup**, not an
 * edge case. So the Modelfile is its own control beside the model rather
 * than a suffix hidden inside a tag: two lanes reading `gemma-4-31b` differ
 * only in the second select, and that difference is the thing the benchmark
 * is measuring.
 *
 * `Lane.model` is the tag Ollama actually loads, which for a variant is the
 * variant's own tag (types.ts). `Lane.modelfile` is the display name beside
 * it. Neither field carries the *base* model a variant was built from, so
 * that is looked back up through `choices` — which is also what makes the
 * chip read `qwen3.8-27b · terse-v2` rather than `terse-v2 · terse-v2`.
 *
 * The store does not exist yet: everything arrives as props, and the caller
 * owns persistence.
 */
import "./LaneEditor.css";
import { laneLabel, newLaneId } from "./benchmarks";
import { MAX_LANES, type Lane } from "./types";
import { shortTag } from "../chat/sessions";

/** What a lane's Modelfile select shows when the lane runs the base model. */
export const BASE_MODELFILE_LABEL = "Original";

/**
 * One configuration the editor can offer.
 *
 * Flat rather than nested (a model carrying a list of variants) because that
 * is exactly the row a lane is: pick one and you have every field `Lane`
 * needs. `base` is the grouping key of the model select; `model` is what
 * goes on the wire.
 */
export interface LaneChoice {
  /** The base model this configuration runs on. Groups the model select. */
  base: string;
  /** The tag actually loaded: the variant's own tag, or the base itself. */
  model: string;
  /** The Modelfile's name, or null for the base model. */
  modelfile: string | null;
}

export interface LaneEditorProps {
  lanes: Lane[];
  /** Every configuration on offer. An empty list disables the editor. */
  choices: LaneChoice[];
  /** True while a run is in flight: the lanes are what is being run. */
  disabled?: boolean;
  /** Replaces the whole lane list. The caller persists it. */
  onChange: (lanes: Lane[]) => void;
  /** Injectable so a test can assert on stable ids. */
  makeLaneId?: () => string;
}

/** The base model a lane runs on, or null when `choices` does not know it. */
function knownBase(lane: Lane, choices: LaneChoice[]): string | null {
  const exact = choices.find((c) => c.model === lane.model && c.modelfile === lane.modelfile);
  if (exact !== undefined) return exact.base;
  return choices.find((c) => c.model === lane.model)?.base ?? null;
}

/** The base model a lane runs on, or its own tag when nothing matches. */
export function laneBase(lane: Lane, choices: LaneChoice[]): string {
  return knownBase(lane, choices) ?? lane.model;
}

/**
 * `gemma-4-31b · Original`, `qwen3.8-27b · terse-v2` — a lane's whole
 * identity in one line, the same shape T2's `laneChipLabel` gives the
 * compare bar.
 *
 * `benchmarks.laneLabel` builds the same string out of the lane alone, which
 * is all a pure module can see. Here there is more to see: a variant's
 * `model` is the variant's own tag, so the label built from it reads
 * `terse-v2 · terse-v2` and loses the base model the lane is actually
 * running. `choices` knows the base, so it is used when it has it and
 * `laneLabel` is the fallback when it does not.
 */
export function laneChipLabel(lane: Lane, choices: LaneChoice[]): string {
  const base = knownBase(lane, choices);
  if (base === null) return laneLabel(lane);
  return `${shortTag(base)} · ${lane.modelfile ?? BASE_MODELFILE_LABEL}`;
}

/** The distinct base models on offer, in the order `choices` gives them. */
export function baseModels(choices: LaneChoice[]): string[] {
  const seen: string[] = [];
  for (const choice of choices) if (!seen.includes(choice.base)) seen.push(choice.base);
  return seen;
}

/** Every Modelfile offered for one base model, in the order given. */
export function modelfilesFor(base: string, choices: LaneChoice[]): LaneChoice[] {
  return choices.filter((c) => c.base === base);
}

/**
 * What a freshly added lane should be.
 *
 * The same base model with a Modelfile no lane is using yet, because that is
 * the setup R7 calls normal and it should cost one click. Failing that, the
 * first configuration nobody has taken.
 */
export function nextLaneChoice(lanes: Lane[], choices: LaneChoice[]): LaneChoice | null {
  if (choices.length === 0) return null;
  const taken = (c: LaneChoice) =>
    lanes.some((l) => l.model === c.model && l.modelfile === c.modelfile);
  const last = lanes[lanes.length - 1];
  if (last !== undefined) {
    const sibling = modelfilesFor(laneBase(last, choices), choices).find((c) => !taken(c));
    if (sibling !== undefined) return sibling;
  }
  return choices.find((c) => !taken(c)) ?? choices[0] ?? null;
}

export function LaneEditor({
  lanes,
  choices,
  disabled = false,
  onChange,
  makeLaneId = () => newLaneId(),
}: LaneEditorProps) {
  const bases = baseModels(choices);
  const full = lanes.length >= MAX_LANES;

  const setLane = (index: number, patch: Partial<Lane>) => {
    onChange(lanes.map((lane, i) => (i === index ? { ...lane, ...patch } : lane)));
  };

  const pickBase = (index: number, base: string) => {
    // Changing the model keeps the Modelfile only when the new base has one
    // by the same name. Otherwise the lane falls back to that base's own
    // Original, which is the only honest default.
    const lane = lanes[index];
    if (lane === undefined) return;
    const siblings = modelfilesFor(base, choices);
    const target =
      siblings.find((c) => c.modelfile === lane.modelfile) ??
      siblings.find((c) => c.modelfile === null) ??
      siblings[0];
    if (target === undefined) return;
    setLane(index, { model: target.model, modelfile: target.modelfile });
  };

  const pickModelfile = (index: number, value: string) => {
    const lane = lanes[index];
    if (lane === undefined) return;
    const siblings = modelfilesFor(laneBase(lane, choices), choices);
    const target = siblings.find((c) => (c.modelfile ?? "") === value);
    if (target === undefined) return;
    setLane(index, { model: target.model, modelfile: target.modelfile });
  };

  const addLane = () => {
    // Guarded here as well as on the button. A disabled control is a
    // courtesy; the cap is the rule.
    if (full) return;
    const choice = nextLaneChoice(lanes, choices);
    if (choice === null) return;
    onChange([...lanes, { id: makeLaneId(), model: choice.model, modelfile: choice.modelfile }]);
  };

  const removeLane = (index: number) => {
    // A benchmark with no lane has nothing to run, so the last one stays.
    if (lanes.length <= 1) return;
    onChange(lanes.filter((_, i) => i !== index));
  };

  return (
    <div className="laneeditor">
      <div className="le-h">
        <b>Lanes</b>
        <span className="le-note">
          One configuration each. The same model with two different Modelfiles is a normal
          setup, and the way you read what a Modelfile changed.
        </span>
      </div>
      <ol className="lanelist">
        {lanes.map((lane, index) => {
          const base = laneBase(lane, choices);
          const siblings = modelfilesFor(base, choices);
          const known = siblings.some((c) => c.modelfile === lane.modelfile);
          const name = `Lane ${index + 1}`;
          return (
            <li key={lane.id} className="lanerow">
              <span className="lane-n">{name}</span>
              <select
                className="lane-sel"
                aria-label={`${name} model`}
                value={base}
                disabled={disabled || choices.length === 0}
                onChange={(e) => pickBase(index, e.target.value)}
              >
                {/* A lane pointing at a model that is no longer installed
                    keeps its own name on the list rather than silently
                    snapping to somebody else's. */}
                {!bases.includes(base) && <option value={base}>{shortTag(base)}</option>}
                {bases.map((b) => (
                  <option key={b} value={b}>
                    {shortTag(b)}
                  </option>
                ))}
              </select>
              <select
                className="lane-sel"
                aria-label={`${name} Modelfile`}
                value={lane.modelfile ?? ""}
                disabled={disabled || siblings.length === 0}
                onChange={(e) => pickModelfile(index, e.target.value)}
              >
                {!known && (
                  <option value={lane.modelfile ?? ""}>
                    {lane.modelfile ?? BASE_MODELFILE_LABEL}
                  </option>
                )}
                {siblings.map((c) => (
                  <option key={c.modelfile ?? " base"} value={c.modelfile ?? ""}>
                    {c.modelfile ?? BASE_MODELFILE_LABEL}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="lane-x"
                aria-label={`Remove lane ${index + 1}`}
                title={
                  lanes.length <= 1
                    ? "A benchmark needs at least one lane"
                    : `Remove lane ${index + 1}`
                }
                disabled={disabled || lanes.length <= 1}
                onClick={() => removeLane(index)}
              >
                &times;
              </button>
            </li>
          );
        })}
      </ol>
      <div className="le-f">
        <button
          type="button"
          className="btn sm"
          disabled={disabled || full || choices.length === 0}
          title={
            full
              ? `A benchmark holds ${MAX_LANES} lanes at most. Each one is a full model load.`
              : choices.length === 0
                ? "No models to choose from yet"
                : "Add a lane"
          }
          onClick={addLane}
        >
          Add lane
        </button>
        <span className="le-cap">
          {lanes.length} of {MAX_LANES} lanes
          {full ? ". Each lane is a full model load, so four is the ceiling." : ""}
        </span>
      </div>
    </div>
  );
}
