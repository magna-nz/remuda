/**
 * The memory check a benchmark run makes before it loads anything
 * (docs/mockup-new-menu.html §05). Pure — no React, no I/O.
 *
 * ## What is and isn't a collision
 *
 * Lanes run **one at a time**: `run.ts` rule 2 loads lane 1's model, answers
 * every prompt with it, and only then loads lane 2's. So two lanes never
 * have to be resident together, and "lane A + lane B won't fit" is not a
 * state this feature can reach. Summing the lanes would invent a problem.
 *
 * What *can* collide is the model you were already chatting to. If **Y** is
 * resident and a lane's model isn't Y, both are in memory at the moment that
 * lane loads — Y still held, the lane's weights arriving beside it. That
 * pair is the check, and it is taken lane by lane:
 *
 *     lane.model === Y.tag  →  reuse; nothing loads
 *     otherwise             →  Y.measured + lane.predicted > usable ?
 *
 * Note the asymmetry: **Y is measured, not predicted.** It is resident, so
 * /api/ps reports its real `size` — a fact. Only the lane about to load
 * needs `predictFit`. That makes half of every comparison exact.
 *
 * ## No prediction is a first-class result
 *
 * `predictFit` refuses to invent numbers, and it refuses in three ordinary
 * situations: no host-memory reading, a discrete GPU (where system RAM says
 * nothing about VRAM), and a server whose `model_info` omits the
 * architecture fields. All three yield `unknown` here — never a pass and
 * never a block. Blocking Run on a figure that could not be computed would
 * make the check worse than not having it.
 *
 * ## The context length is observed, not assumed
 *
 * KV cache is linear in context, so the context a runner is *actually*
 * started with decides how much of this estimate is real. Remuda sends no
 * `num_ctx` for a benchmark (run.ts), so Ollama chooses — and recent versions
 * size the context to available memory rather than to a fixed default. On a
 * 27B q8 the gap between a guessed 4096 and an observed 26,624 is 6 GB of KV,
 * which is the whole margin this check exists to protect.
 *
 * So the figure is taken from `/api/ps`, which reports the context every
 * resident runner was started with — a measurement of what this server does
 * on this machine. The constant is only a fallback for when nothing has been
 * loaded yet to observe, and it is deliberately the *low* end: with nothing
 * resident there is also no collision to miss.
 */
import { predictFit } from "../models/fit";
import { sameTag } from "../models/tags";
import { UNCONFIGURED_LANE } from "./benchmarks";
import type { Lane } from "./types";
import type { Model, RunningModel } from "../api/types";

/** One lane's verdict. */
export type LaneVerdict =
  /** The lane's model is already resident — nothing loads for it. */
  | { kind: "reuse"; laneId: string; model: string }
  /** Fits alongside whatever is resident. */
  | { kind: "fits"; laneId: string; model: string; totalBytes: number }
  /** Doesn't fit *because* something else is resident. Unloading would help. */
  | { kind: "collides"; laneId: string; model: string; laneBytes: number; residentBytes: number; usableBytes: number }
  /** Doesn't fit even on an empty machine. Unloading would not help. */
  | { kind: "too-big"; laneId: string; model: string; laneBytes: number; usableBytes: number }
  /** Could not be predicted, with the predictor's own reason. */
  | { kind: "unknown"; laneId: string; model: string; reason: string };

export interface Preflight {
  lanes: LaneVerdict[];
  /**
   * The resident models a run would have to displace, in the order /api/ps
   * gave them. Empty when nothing needs unloading — including when a lane is
   * simply too big, since unloading these would not save it.
   */
  blockers: { tag: string; sizeBytes: number; pinned: boolean }[];
  /** True when at least one lane collides — i.e. unloading would help. */
  needsUnload: boolean;
  /** True when at least one lane cannot fit even with the machine emptied. */
  hasTooBig: boolean;
  /** True when every lane's verdict is `unknown` — nothing could be checked. */
  allUnknown: boolean;
}

export interface PreflightInputs {
  lanes: Lane[];
  /** Every installed model, for weights and `archParams`. */
  models: Model[];
  /** /api/ps — the measured half of the comparison, contexts included. */
  running: RunningModel[];
  /** null when there is no honest reading (no bridge, or a discrete GPU). */
  usableVramBytes: number | null;
  /** Used only when no resident runner has reported a context to observe. */
  fallbackCtx: number;
  /** Per-tag KV calibration from real loads (models/fitCalibration.ts). */
  calibrationFactorFor?: (tag: string) => number | null;
}

/**
 * The context a lane's runner will be started with, as this server has
 * actually been observed to choose it.
 *
 * The largest of the resident runners' contexts rather than the mean or the
 * first: under-estimating KV is the failure that costs a wasted load, and
 * over-estimating only costs a question the user can dismiss.
 */
export function observedCtx(running: RunningModel[], fallbackCtx: number): number {
  const seen = running
    .map((r) => r.contextLength)
    .filter((c): c is number => typeof c === "number" && c > 0);
  return seen.length > 0 ? Math.max(...seen) : fallbackCtx;
}

/**
 * A pinned model (`keep_alive: -1`, surfaced as a null `expiresAt`) is the
 * case that actually strands a run: Ollama will not evict it to make room,
 * so saying nothing leaves the load to fail on its own.
 */
function isPinned(entry: RunningModel): boolean {
  return entry.expiresAt === null;
}

export function preflight(inputs: PreflightInputs): Preflight {
  const { lanes, models, running, usableVramBytes, fallbackCtx } = inputs;
  const calibration = inputs.calibrationFactorFor ?? (() => null);
  const runCtx = observedCtx(running, fallbackCtx);

  const verdicts: LaneVerdict[] = [];
  const blockerTags = new Set<string>();

  for (const lane of lanes) {
    // An unconfigured lane has nothing to weigh. Run refuses on it for a
    // different reason (`isConfigured`), so it is not this check's to report.
    if (lane.model === UNCONFIGURED_LANE) continue;

    // Normalised, not literal: /api/ps and /api/tags disagree about the
    // implicit `:latest` and about case (models/tags.ts). A literal compare
    // misses a resident model here *and* leaves it in `others` below, so the
    // same weights get counted twice and the run is stopped to offer an
    // unload of the very model the lane wanted to reuse.
    const resident = running.find((r) => sameTag(r.tag, lane.model)) ?? null;
    if (resident !== null) {
      verdicts.push({ kind: "reuse", laneId: lane.id, model: lane.model });
      continue;
    }

    const model = models.find((m) => sameTag(m.tag, lane.model)) ?? null;
    if (model === null) {
      verdicts.push({
        kind: "unknown",
        laneId: lane.id,
        model: lane.model,
        reason: "this model isn't installed",
      });
      continue;
    }

    const factor = calibration(lane.model);
    // A model cannot be given more context than it was trained for, so the
    // observed figure is a ceiling, not a promise.
    const laneCtx = model.contextLength === null ? runCtx : Math.min(runCtx, model.contextLength);
    const fit = predictFit({
      archParams: model.archParams,
      weightsBytes: model.sizeBytes,
      usableVramBytes,
      ctx: laneCtx,
      trainedCtx: model.contextLength,
      calibrationFactor: factor ?? 1,
    });
    if (!fit.ok) {
      verdicts.push({ kind: "unknown", laneId: lane.id, model: lane.model, reason: fit.reason });
      continue;
    }

    // Everything resident that this lane does *not* reuse is still held when
    // it loads. Summed, because Ollama can hold several at once.
    const others = running.filter((r) => !sameTag(r.tag, lane.model));
    const residentBytes = others.reduce((sum, r) => sum + r.sizeBytes, 0);

    if (fit.totalBytes > fit.usableVramBytes) {
      // Too big on its own: unloading Y cannot save it, so it is not a
      // collision and Y is not a blocker for it.
      verdicts.push({
        kind: "too-big",
        laneId: lane.id,
        model: lane.model,
        laneBytes: fit.totalBytes,
        usableBytes: fit.usableVramBytes,
      });
      continue;
    }
    if (fit.totalBytes + residentBytes > fit.usableVramBytes) {
      for (const other of others) blockerTags.add(other.tag);
      verdicts.push({
        kind: "collides",
        laneId: lane.id,
        model: lane.model,
        laneBytes: fit.totalBytes,
        residentBytes,
        usableBytes: fit.usableVramBytes,
      });
      continue;
    }
    verdicts.push({ kind: "fits", laneId: lane.id, model: lane.model, totalBytes: fit.totalBytes });
  }

  const blockers = running
    .filter((r) => blockerTags.has(r.tag))
    .map((r) => ({ tag: r.tag, sizeBytes: r.sizeBytes, pinned: isPinned(r) }));

  return {
    lanes: verdicts,
    blockers,
    needsUnload: verdicts.some((v) => v.kind === "collides"),
    hasTooBig: verdicts.some((v) => v.kind === "too-big"),
    allUnknown: verdicts.length > 0 && verdicts.every((v) => v.kind === "unknown"),
  };
}
