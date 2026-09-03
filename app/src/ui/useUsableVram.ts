/**
 * Usable VRAM for the fit predictor, read **once**.
 *
 * `useHostStats` polls, because CPU load and used memory change while you
 * watch them. Nothing here does: `predictFit` needs only `memTotalBytes` and
 * `memIsUnified`, which are properties of the machine, not of the moment. A
 * timer re-reading them every few seconds would be pure waste — and mounted
 * for the life of a pane rather than the life of a popover, it is waste that
 * never stops.
 *
 * `null` means **no prediction is possible**, and is returned for two
 * different reasons that the caller treats the same way: there is no desktop
 * bridge (a browser tab, or a test), or the memory is not unified — on a
 * discrete GPU, system RAM says nothing about VRAM, and
 * `usableVramFromHostMemory` refuses rather than answering confidently and
 * wrongly.
 */
import { useEffect, useState } from "react";
import { hostStats } from "../api/host";
import { usableVramFromHostMemory } from "../models/fit";

export function useUsableVram(): number | null {
  const [usable, setUsable] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    hostStats()
      .then((stats) => {
        if (cancelled || stats === null) return;
        setUsable(usableVramFromHostMemory(stats.memTotalBytes, stats.memIsUnified));
      })
      // A bridge that is there and fails is still "no reading". The fit
      // predictor's own contract covers it: no prediction, never a guess.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return usable;
}
