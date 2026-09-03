/**
 * Host telemetry for the Runtime popover (SPEC-tuning T7).
 *
 * Polls `hostStats()` on the same 5s cadence as the app's existing `/api/ps`
 * poll — never faster, because a telemetry panel that polls quicker than its
 * data changes is a battery drain. The gating that matters most, though, is
 * *when* this hook runs at all: it has no "is the popover open" flag of its
 * own, because the flag already exists one layer up — `RuntimePopover` is
 * only ever mounted while open, so this hook's own mount/unmount lifecycle
 * is the gate. Closing the popover unmounts it, which is what actually stops
 * the timer; there is nothing here that could poll while nothing is looking.
 *
 * `hostStats()` resolves to `null` with no Tauri bridge (every vitest run,
 * every plain browser tab) — that is the default rendering path this hook
 * must support cleanly, not an edge case.
 */
import { useEffect, useRef, useState } from "react";
import { hostStats, type HostStats } from "../api/host";

/** Mirrors the existing `/api/ps` poll cadence (SPEC-tuning T7). */
export const HOST_STATS_POLL_MS = 5000;

/** Five minutes of samples at the 5s cadence, and nothing more. */
export const CPU_HISTORY_LENGTH = 60;

export interface UseHostStatsResult {
  /** Latest reading, or `null` when there is no bridge or a call is still in flight. */
  stats: HostStats | null;
  /** Rolling window of `ollamaCpuPercent` readings, oldest first, capped at 60. */
  cpuHistory: number[];
}

/**
 * `pollMs` defaults to the shared 5s cadence; tests may override it to avoid
 * waiting out a real 5-second timer.
 */
export function useHostStats(pollMs: number = HOST_STATS_POLL_MS): UseHostStatsResult {
  const [stats, setStats] = useState<HostStats | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const tick = () => {
      hostStats()
        .then((sample) => {
          if (cancelledRef.current) return;
          setStats(sample);
          if (sample !== null && sample.ollamaCpuPercent !== null) {
            const reading = sample.ollamaCpuPercent;
            setCpuHistory((prev) => [...prev, reading].slice(-CPU_HISTORY_LENGTH));
          }
        })
        .catch(() => {
          // A rejection means the bridge was there and the call failed —
          // treat it the same as "no reading right now" rather than
          // crashing the popover over a diagnostic panel.
          if (!cancelledRef.current) setStats(null);
        });
    };

    tick();
    const id = window.setInterval(tick, pollMs);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(id);
    };
  }, [pollMs]);

  return { stats, cpuHistory };
}
