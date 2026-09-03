/**
 * Help dismissal state (docs/SPEC-round-two.md R5).
 *
 * One flat set of pane ids the user has closed. Absence is the default, so a
 * pane nobody has ever dismissed reads as **open** — the explainer is offered
 * once without anyone having to go looking for it, and an experienced user
 * closes each `?` once and never sees it again.
 *
 * Same persistence idiom as ui/state.tsx's settings and tools/toolsets.ts:
 * an exported key, pure load/save, per-field coercion, try/catch returning a
 * safe default. Corrupt or absent JSON means "nothing dismissed" — never a
 * throw, because losing which explainers you closed is a trivial cost and a
 * crash on boot is not.
 *
 * Reads hit localStorage directly rather than a module-level cache: the
 * volume is one small array read on mount and on change, and a cache would
 * go stale the moment anything else wrote the key.
 */

/**
 * Do not bump this key without a migration: a new key reopens every
 * explainer the user has already closed. Any field added later must be
 * optional so a v1 payload still loads (SPEC §6).
 */
export const HELP_STORAGE_KEY = "remuda.help.v1";

interface PersistedHelp {
  /** Pane ids whose "About this pane" strip is closed. */
  dismissed: string[];
}

function read(): Set<string> {
  try {
    const raw = window.localStorage.getItem(HELP_STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return new Set();
    const value = (parsed as Record<string, unknown>).dismissed;
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    // Unparseable payload, or no storage at all (private mode): nothing is
    // dismissed, so every pane shows its help. The next write repairs it.
    return new Set();
  }
}

function write(dismissed: Set<string>): void {
  try {
    const payload: PersistedHelp = { dismissed: Array.from(dismissed) };
    window.localStorage.setItem(HELP_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota/private-mode failures: the dismissal simply won't survive a restart.
  }
}

/**
 * Change listeners. Two components share one pane's state — the `?` in the
 * header and the strip below it — and Settings → Reopen all changes every
 * pane at once from a third place. A subscription keeps all three in step
 * without threading state through panes that don't care.
 */
const listeners = new Set<() => void>();

function notify(): void {
  // Copied before iterating: a listener may unsubscribe as it runs.
  for (const listener of Array.from(listeners)) listener();
}

/** Subscribe to dismissal changes. Returns the unsubscribe function. */
export function subscribeHelp(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every pane id currently dismissed. */
export function dismissedPanes(): ReadonlySet<string> {
  return read();
}

/** Whether this pane's help strip should be showing. Unseen panes are open. */
export function isPaneHelpOpen(paneId: string): boolean {
  return !read().has(paneId);
}

/** Open or close one pane's help strip, and persist it. */
export function setPaneHelpOpen(paneId: string, open: boolean): void {
  const dismissed = read();
  if (open === !dismissed.has(paneId)) return; // No change, so no write and no notify.
  if (open) dismissed.delete(paneId);
  else dismissed.add(paneId);
  write(dismissed);
  notify();
}

/**
 * Clear every dismissal — Settings → Reopen all (R5).
 *
 * Remembering what you closed is right for the machine's owner and wrong for
 * whoever they hand the laptop to, so this is one button rather than a
 * per-pane list.
 */
export function reopenAll(): void {
  try {
    window.localStorage.removeItem(HELP_STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable; the in-memory default is
    // already "nothing dismissed".
  }
  notify();
}
