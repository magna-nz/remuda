/**
 * The step-target registry (R6). The interesting case is absence: the tour's
 * whole skip rule rests on "this step has no target" being a fact it can
 * read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerTourTarget, subscribeTourTargets, tourTarget, tourTargetVersion } from "./registry";

beforeEach(() => {
  registerTourTarget("model-control", null);
  registerTourTarget("format", null);
});

describe("the tour target registry", () => {
  it("hands back the element a step registered", () => {
    const el = document.createElement("button");
    document.body.append(el);
    registerTourTarget("model-control", el);
    expect(tourTarget("model-control")).toBe(el);
    el.remove();
  });

  it("reports an unregistered step as absent", () => {
    expect(tourTarget("format")).toBeNull();
  });

  it("reports a detached element as absent rather than measuring a ghost", () => {
    const el = document.createElement("button");
    document.body.append(el);
    registerTourTarget("format", el);
    expect(tourTarget("format")).toBe(el);
    el.remove();
    expect(tourTarget("format")).toBeNull();
  });

  it("bumps the version and notifies on every change, and on nothing else", () => {
    const seen = vi.fn();
    const unsubscribe = subscribeTourTargets(seen);
    const before = tourTargetVersion();
    const el = document.createElement("button");
    document.body.append(el);

    registerTourTarget("model-control", el);
    registerTourTarget("model-control", el); // Same element: no change.
    expect(seen).toHaveBeenCalledTimes(1);
    expect(tourTargetVersion()).toBe(before + 1);

    registerTourTarget("model-control", null);
    registerTourTarget("model-control", null); // Already gone: no change.
    expect(seen).toHaveBeenCalledTimes(2);

    unsubscribe();
    registerTourTarget("model-control", el);
    expect(seen).toHaveBeenCalledTimes(2);
    el.remove();
    registerTourTarget("model-control", null);
  });
});
