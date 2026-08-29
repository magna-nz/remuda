/**
 * Is the tour running? (docs/SPEC-round-two.md R6.)
 *
 * Deliberately *not* persisted: a tour interrupted by a reload should not
 * come back mid-step. And deliberately not in `ui/state.tsx` either — three
 * unrelated places start or stop it (the first-run card, Settings → Run the
 * tour, the card's own Esc) and none of them share a parent worth threading
 * a prop through. Module-level with a subscription is the pattern
 * `help/persistence.ts` already established here.
 */
import { useSyncExternalStore } from "react";

let running = false;
const listeners = new Set<() => void>();

function notify(): void {
  // Copied before iterating: a listener may unsubscribe as it runs.
  for (const listener of Array.from(listeners)) listener();
}

/** Start at step one. A second call while it is already running does nothing. */
export function startTour(): void {
  if (running) return;
  running = true;
  notify();
}

/** Leave — Skip, Done, or Esc. */
export function stopTour(): void {
  if (!running) return;
  running = false;
  notify();
}

export function isTourRunning(): boolean {
  return running;
}

export function subscribeTourRunning(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Live "is the tour running" for a component. */
export function useTourRunning(): boolean {
  return useSyncExternalStore(subscribeTourRunning, isTourRunning, isTourRunning);
}
