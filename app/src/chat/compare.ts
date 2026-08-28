/**
 * A/B compare — the pure parts (docs/SPEC-tuning.md T2).
 *
 * No React, no store, no client. Everything here is a function of a session's
 * `compare` block and its transcript, which is what makes the two rules that
 * matter testable on their own:
 *
 *   1. **Both lanes run on one seed**, or the comparison measures sampling
 *      noise rather than the configurations.
 *   2. **Each lane continues its own conversation.** A compare turn stores
 *      one user message and two replies; feeding a lane the *other* lane's
 *      reply as history would make the second turn a comparison of two
 *      different conversations.
 */
import type { RunOptions } from "../api/types";
import { shortTag, type CompareConfig, type Lane, type LaneConfig, type Message } from "./sessions";
import { countOverrides } from "./RunControls";

export const LANES: readonly [Lane, Lane] = ["a", "b"];

/** Position of a lane in `CompareConfig.lanes`. */
export function laneIndex(lane: Lane): 0 | 1 {
  return lane === "a" ? 0 : 1;
}

export function laneConfig(compare: CompareConfig, lane: Lane): LaneConfig {
  return compare.lanes[laneIndex(lane)];
}

/** Replace one lane's config, leaving the other untouched. */
export function withLane(
  compare: CompareConfig,
  lane: Lane,
  patch: Partial<LaneConfig>,
): CompareConfig {
  const next: [LaneConfig, LaneConfig] = [compare.lanes[0], compare.lanes[1]];
  const i = laneIndex(lane);
  next[i] = { ...next[i], ...patch };
  return { ...compare, lanes: next };
}

/**
 * A seed to pin for a run. Small enough to read on a chip, and never equal to
 * `exclude` — "Regenerate with a *new* seed" that happened to redraw the old
 * one would silently be the same run.
 */
export function randomSeed(exclude?: number): number {
  for (;;) {
    const seed = Math.floor(Math.random() * 99_999) + 1;
    if (seed !== exclude) return seed;
  }
}

/** True when neither lane names a seed of its own — the case a pin is for. */
export function neitherLaneSetsSeed(lanes: readonly [LaneConfig, LaneConfig]): boolean {
  return lanes.every((l) => l.options?.seed === undefined);
}

/**
 * The options one lane actually runs with.
 *
 * The pin wins where it is set: that is the whole point of pinning. A lane
 * that names its own seed is a deliberate per-lane difference, and setting
 * one unpins the pair (see `setLaneOptions` in ui/state.tsx) rather than
 * being quietly overridden here.
 */
export function effectiveLaneOptions(
  compare: CompareConfig,
  lane: Lane,
): RunOptions | undefined {
  const own = laneConfig(compare, lane).options;
  if (compare.seed === null) return own;
  return { ...own, seed: compare.seed };
}

/**
 * The history one lane sends.
 *
 * Unlaned messages — every user message, and every reply from before compare
 * was switched on — are shared; laned ones belong to whoever produced them.
 */
export function historyForLane(messages: Message[], lane: Lane): Message[] {
  return messages.filter((m) => {
    if (m.lane !== undefined && m.lane !== lane) return false;
    // A lane that errored leaves an assistant message with nothing in it.
    // Sending `{ role: "assistant", content: "" }` back as history hands the
    // model a turn where it said nothing — so the lane that already failed
    // once gets a degraded prompt on the next turn too.
    if (m.role === "assistant" && m.content === "" && (m.thinking ?? "") === "") return false;
    return true;
  });
}

/** True when the run will unload one model and load the other (T2's warning). */
export function swapsModel(compare: CompareConfig): boolean {
  return compare.lanes[0].model !== compare.lanes[1].model;
}

/** `terse-v2 · 3 overrides` — a lane's whole identity, per the mockup. */
export function laneChipLabel(config: LaneConfig): string {
  const name = shortTag(config.modelfile ?? config.model);
  const count = countOverrides(config.options);
  return count === 0 ? name : `${name} · ${count} override${count === 1 ? "" : "s"}`;
}

/**
 * Which lane won one metric — and only one metric.
 *
 * There is deliberately no aggregate: "which is better" is the judgement the
 * user is here to make, and a product that scored it would be answering the
 * question it was asked to help with. A tie, or a number either side didn't
 * report, wins nothing.
 */
export function winnerBy(
  a: number | null | undefined,
  b: number | null | undefined,
  direction: "higher" | "lower",
): Lane | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (a === b) return null;
  const aWins = direction === "higher" ? a > b : a < b;
  return aWins ? "a" : "b";
}
