/**
 * The step-target registry (docs/SPEC-round-two.md R6).
 *
 * The tour runs on the **real** UI, so it needs the live element behind each
 * step. Components register one by step id through `useTourTarget`, whose
 * ref callback fires on mount and again with `null` on unmount — which is
 * what makes "this step's target isn't on screen" a fact the tour can read
 * rather than guess at. The Tools tab only exists for tool-capable models,
 * the composer only exists once there's a chat: absence is normal here, not
 * an error.
 *
 * Module-level rather than a context, the same shape `help/persistence.ts`
 * uses: one writer per element and one reader (the tour), with nothing to
 * thread through the panes in between.
 */
import { useCallback } from "react";
import type { TourStepId } from "./steps";

const targets = new Map<TourStepId, HTMLElement>();
const listeners = new Set<() => void>();

/**
 * Bumped on every registration change. It is the `useSyncExternalStore`
 * snapshot: a number compares by value, where the Map would compare by
 * identity and re-render forever.
 */
let version = 0;

function notify(): void {
  version += 1;
  // Copied before iterating: a listener may unsubscribe as it runs.
  for (const listener of Array.from(listeners)) listener();
}

/** Attach (or, with `null`, detach) the element a step points at. */
export function registerTourTarget(id: TourStepId, el: HTMLElement | null): void {
  const current = targets.get(id) ?? null;
  if (el === null) {
    if (current === null) return;
    targets.delete(id);
    notify();
    return;
  }
  if (current === el) return;
  targets.set(id, el);
  notify();
}

/**
 * The element for a step, or null if nothing is registered — or if what is
 * registered has left the document without its ref callback firing. React
 * always fires it, but a detached node would be measured as a zero-size
 * rectangle in the top-left corner, which is worse than skipping the step.
 */
export function tourTarget(id: TourStepId): HTMLElement | null {
  const el = targets.get(id) ?? null;
  if (el === null) return null;
  return el.isConnected ? el : null;
}

/** Subscribe to registration changes. Returns the unsubscribe function. */
export function subscribeTourTargets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current registration version — `useSyncExternalStore`'s snapshot. */
export function tourTargetVersion(): number {
  return version;
}

/**
 * The registration call a targeted component makes:
 * `<button ref={useTourTarget("model-control")}>`. One attribute, no state,
 * and nothing to clean up — the callback's own `null` call does that.
 */
export function useTourTarget(id: TourStepId): (el: HTMLElement | null) => void {
  return useCallback((el: HTMLElement | null) => registerTourTarget(id, el), [id]);
}
