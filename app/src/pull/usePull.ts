/**
 * Pull state (SPEC.md §5.5, §8, §9).
 *
 * One pull at a time — SPEC §8 says pulls "run in the background" but
 * doesn't require *concurrent* pulls, and one-at-a-time is the simplest
 * honest v1: a second `startPull` while one is in flight is a no-op until
 * the first finishes, fails, or is canceled.
 */
import { useCallback, useRef, useState } from "react";
import type { OllamaClient, PullProgress } from "../api/types";

export interface PullLayer {
  digest: string;
  completed: number;
  total: number;
}

export interface PullCardState {
  tag: string;
  /** Per-`sha256:` blob progress, in the order first seen. */
  layers: PullLayer[];
  /** Latest streamed status line (e.g. "pulling manifest", "verifying sha256 digest"). */
  statusLine: string;
  /** Set when the stream failed; the card then shows this + Retry (SPEC §9). */
  error: string | null;
}

function applyEvent(prev: PullCardState | null, tag: string, event: PullProgress): PullCardState {
  const base: PullCardState = prev && prev.tag === tag ? prev : { tag, layers: [], statusLine: "", error: null };
  if (event.digest !== undefined) {
    const idx = base.layers.findIndex((l) => l.digest === event.digest);
    const existing = idx >= 0 ? base.layers[idx] : undefined;
    const layer: PullLayer = {
      digest: event.digest,
      completed: event.completed ?? existing?.completed ?? 0,
      total: event.total ?? existing?.total ?? 0,
    };
    const layers = idx >= 0 ? base.layers.map((l, i) => (i === idx ? layer : l)) : [...base.layers, layer];
    return { ...base, layers, statusLine: event.status };
  }
  return { ...base, statusLine: event.status };
}

export interface UsePullOptions {
  client: OllamaClient;
  /** Re-fetch the installed model list after a successful pull. */
  refreshModels: () => Promise<void>;
}

export interface UsePullResult {
  /** Null when nothing is pulling (SPEC §5.5's empty state: just bar + Popular). */
  pullState: PullCardState | null;
  /** True while a pull is streaming (governs the one-at-a-time guard + disabled buttons). */
  busy: boolean;
  /** No-op if a pull is already in flight or the tag is blank. */
  startPull: (tag: string) => void;
  /** Aborts the in-flight stream; the card is cleared, not left as an error. */
  cancelPull: () => void;
  /** Re-runs the last pull's tag after a failure (SPEC §9). */
  retryPull: () => void;
}

export function usePull({ client, refreshModels }: UsePullOptions): UsePullResult {
  const [pullState, setPullState] = useState<PullCardState | null>(null);
  const [busy, setBusy] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const runPull = useCallback(
    async (tag: string) => {
      const controller = new AbortController();
      controllerRef.current = controller;
      setBusy(true);
      setPullState({ tag, layers: [], statusLine: "starting…", error: null });
      try {
        for await (const event of client.pull(tag, controller.signal)) {
          setPullState((prev) => applyEvent(prev, tag, event));
        }
        // Stream completed without throwing: success (SPEC §5.5 — re-fetch /api/tags).
        await refreshModels().catch(() => {});
        setPullState(null);
      } catch (err) {
        const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
        if (aborted) {
          setPullState(null);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          setPullState((prev) =>
            prev && prev.tag === tag
              ? { ...prev, error: message }
              : { tag, layers: [], statusLine: "", error: message },
          );
        }
      } finally {
        controllerRef.current = null;
        setBusy(false);
      }
    },
    [client, refreshModels],
  );

  const startPull = useCallback(
    (rawTag: string) => {
      const tag = rawTag.trim();
      if (tag === "" || controllerRef.current !== null) return;
      void runPull(tag);
    },
    [runPull],
  );

  const cancelPull = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const retryPull = useCallback(() => {
    if (controllerRef.current !== null || pullState === null) return;
    void runPull(pullState.tag);
  }, [pullState, runPull]);

  return { pullState, busy, startPull, cancelPull, retryPull };
}
