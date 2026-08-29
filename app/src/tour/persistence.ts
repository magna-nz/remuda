/**
 * Whether the first-run offer has been answered (docs/SPEC-round-two.md R6).
 *
 * One boolean, persisted, because the offer is *offered* — a card the user
 * can ignore entirely — and an offer that comes back on every launch has
 * stopped being an offer. "Not now" and "Take the tour" both settle it; only
 * a genuinely first launch has nothing stored.
 *
 * Same idiom as `help/persistence.ts`: an exported key, a defensive parse,
 * a try/catch returning the safe default. Corrupt or absent JSON reads as
 * "not yet answered" — showing the card once more is a trivial cost, and a
 * throw on boot is not.
 */

/**
 * Do not bump this key without a migration: a new key re-offers the tour to
 * everyone who has already declined it. Any field added later must be
 * optional so a v1 payload still loads (SPEC §6).
 */
export const TOUR_STORAGE_KEY = "remuda.tour.v1";

interface PersistedTour {
  /** True once the user has answered the first-run card, either way. */
  offerDismissed: boolean;
}

function read(): boolean {
  try {
    const raw = window.localStorage.getItem(TOUR_STORAGE_KEY);
    if (raw === null) return false;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return false;
    return (parsed as Record<string, unknown>).offerDismissed === true;
  } catch {
    // Unparseable payload, or no storage at all (private mode): the offer
    // stands. The next answer repairs the key.
    return false;
  }
}

function write(offerDismissed: boolean): void {
  try {
    const payload: PersistedTour = { offerDismissed };
    window.localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota/private-mode failure: the card will be offered again next launch.
  }
}

const listeners = new Set<() => void>();

function notify(): void {
  // Copied before iterating: a listener may unsubscribe as it runs.
  for (const listener of Array.from(listeners)) listener();
}

/** Subscribe to changes in the offer's state. Returns the unsubscribe function. */
export function subscribeTourOffer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the first-run card has already been answered. */
export function isFirstRunOfferDismissed(): boolean {
  return read();
}

/** Answer it — "Not now" and "Take the tour" both land here. */
export function dismissFirstRunOffer(): void {
  if (read()) return; // No change, so no write and no notify.
  write(true);
  notify();
}
