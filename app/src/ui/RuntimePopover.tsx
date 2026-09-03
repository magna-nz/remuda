/**
 * The Runtime popover (SPEC-tuning T7): the full readout behind the top
 * bar's three chips — host memory, the loaded model's VRAM/RAM split,
 * Ollama's CPU load with a sparkline, GPU utilisation where it can be read
 * honestly, the context window's occupancy, and keep_alive + Eject.
 *
 * Every figure that is unavailable is **absent, never zero**: a missing
 * Tauri bridge drops the host-memory, CPU and GPU rows entirely rather than
 * greying them or showing 0%. Since `hostStats()` resolves to `null` in
 * every test and in a plain browser tab, that is the *default* rendering
 * path here, not a rare edge case — see the "no bridge" branch below.
 */
import { useEffect, useState } from "react";
import "./RuntimePopover.css";
import { useRemuda } from "./state";
import { useHostStats } from "./useHostStats";
import { formatSize } from "./TopNav";
import type { RunningModel } from "../api/types";

/** The VRAM/RAM split for one resident model — a real, meaningful zero when
 * fully resident, not an "unavailable" figure, so it is shown plainly. */
interface Split {
  vramBytes: number;
  ramBytes: number;
  spilling: boolean;
}

function splitOf(entry: RunningModel): Split | null {
  if (entry.sizeBytes <= 0) return null;
  const vramBytes = entry.sizeVramBytes;
  const ramBytes = Math.max(0, entry.sizeBytes - vramBytes);
  return { vramBytes, ramBytes, spilling: ramBytes > 0 };
}

/**
 * mm:ss countdown, floored at zero. Deliberately re-implemented rather than
 * imported: `TopNav.tsx` already carries its own literal copy for the same
 * reason documented there — the two owning files keep the shape local
 * instead of manufacturing a shared module across an otherwise-unrelated
 * boundary.
 */
function formatCountdown(expiresAt: string, nowMs: number): string {
  const target = Date.parse(expiresAt);
  if (Number.isNaN(target)) return "—";
  const remainingSec = Math.max(0, Math.floor((target - nowMs) / 1000));
  const m = Math.floor(remainingSec / 60);
  const s = remainingSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

export function RuntimePopover({ onClose }: { onClose: () => void }) {
  const { running, activeModel, lastStats, activeSessionId, unload } = useRemuda();
  const { stats, cpuHistory } = useHostStats();
  const [ejecting, setEjecting] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const runningEntry = activeModel ? running.find((r) => r.tag === activeModel.variant) ?? null : null;
  const expiresAt = runningEntry?.expiresAt ?? null;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Same guard as the top bar's own countdown: only tick while there is
  // something to count down to.
  useEffect(() => {
    if (expiresAt === null) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  // Nothing resident under `activeModel` means there is nothing to report —
  // the chips that open this popover are themselves gated on a resident
  // model, so this is defensive rather than a normal path.
  if (runningEntry === null) return null;

  const split = splitOf(runningEntry);
  const contextWindow = runningEntry.contextLength;
  const contextUsed =
    lastStats !== null && lastStats.sessionId === activeSessionId ? lastStats.contextTokens : null;
  const contextPct = contextUsed !== null && contextWindow !== null ? pct(contextUsed, contextWindow) : null;
  const contextAmber = contextPct !== null && contextPct >= 90;

  const handleEject = () => {
    setEjecting(true);
    void unload(runningEntry.tag).finally(() => {
      setEjecting(false);
      onClose();
    });
  };

  return (
    <div className="rpop" role="dialog" aria-label="Runtime">
      <div className="rpop-h">
        <b>Runtime</b>
        <span className="spacer" />
        <span className="hs">{runningEntry.tag}</span>
        <button
          type="button"
          className="btn ghost sm x"
          aria-label="Close runtime details"
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      {/*
       * Host memory, Ollama CPU and GPU utilisation all come from the Rust
       * bridge (`hostStats()`), which is `null` with no Tauri shell — every
       * vitest run and every plain browser tab. No bridge means these three
       * rows do not render at all, not greyed and not zeroed.
       */}
      {stats !== null && (
        <div className="rsec">
          <div className="rlab">
            Host memory
            <span className="rv">
              {formatSize(stats.memUsedBytes)} / {formatSize(stats.memTotalBytes)}
            </span>
          </div>
          {(() => {
            const thisModel = Math.min(runningEntry.sizeBytes, stats.memUsedBytes);
            const other = Math.max(0, stats.memUsedBytes - thisModel);
            const free = Math.max(0, stats.memTotalBytes - stats.memUsedBytes);
            return (
              <>
                <div className="segbar">
                  <i style={{ width: `${pct(thisModel, stats.memTotalBytes)}%`, background: "var(--ember)" }} />
                  <i style={{ width: `${pct(other, stats.memTotalBytes)}%`, background: "var(--border-strong)" }} />
                  <i style={{ flex: 1, background: "var(--border)" }} />
                </div>
                <div className="legend">
                  <span>
                    <i style={{ background: "var(--ember)" }} />
                    this model {formatSize(thisModel)}
                  </span>
                  <span>
                    <i style={{ background: "var(--border-strong)" }} />
                    other {formatSize(other)}
                  </span>
                  <span>
                    <i style={{ background: "var(--border)" }} />
                    free {formatSize(free)}
                  </span>
                </div>
              </>
            );
          })()}
          <div className="rnote">
            The model's share <b>of the whole machine</b> is what answers "can I open anything else?"
          </div>
        </div>
      )}

      {split !== null && (
        <div className="rsec">
          <div className="rlab">
            Model placement
            <span className={`rv${split.spilling ? " warn" : " good"}`}>
              {formatSize(split.vramBytes)} GPU · {formatSize(split.ramBytes)} RAM
            </span>
          </div>
          <div className="segbar">
            <i style={{ width: `${pct(split.vramBytes, runningEntry.sizeBytes)}%`, background: "var(--good)" }} />
            {split.spilling && <i style={{ flex: 1, background: "var(--warn)" }} />}
          </div>
        </div>
      )}

      {stats !== null && stats.ollamaCpuPercent !== null && (
        <div className="rsec">
          <div className="rlab">
            Ollama CPU
            <span className="rv">{stats.ollamaCpuPercent}%</span>
          </div>
          <div className="spark">
            {cpuHistory.map((v, i) => (
              <i key={i} style={{ height: `${Math.max(2, Math.min(100, v))}%` }} />
            ))}
          </div>
          <div className="rnote">The Ollama process, not the machine.</div>
        </div>
      )}

      {stats !== null &&
        (stats.gpuPercent !== null ? (
          <div className="rsec">
            <div className="rlab">
              GPU utilisation
              <span className="rv">{stats.gpuPercent}%</span>
            </div>
            <div className={`meter${stats.gpuPercent >= 90 ? " warn" : " good"}`}>
              <i style={{ width: `${stats.gpuPercent}%` }} />
            </div>
          </div>
        ) : (
          <div className="rsec">
            <div className="absent">GPU utilisation unavailable on this machine</div>
            <div className="rnote">Absent, never zero. A meter pinned at 0% is a lie a user will act on.</div>
          </div>
        ))}

      {contextWindow !== null && (
        <div className="rsec">
          <div className="rlab">
            {contextUsed !== null ? "Context used" : "Context window"}
            <span className={`rv${contextAmber ? " warn" : ""}`}>
              {contextUsed !== null
                ? `${contextUsed.toLocaleString("en-US")} / ${contextWindow.toLocaleString("en-US")} · ${contextPct}%`
                : contextWindow.toLocaleString("en-US")}
            </span>
          </div>
          {contextPct !== null && (
            <div className={`meter${contextAmber ? " warn" : " good"}`}>
              <i style={{ width: `${contextPct}%` }} />
            </div>
          )}
          <div className="rnote" style={contextAmber ? { color: "var(--warn)" } : undefined}>
            {contextAmber
              ? "Older turns will start dropping."
              : "Measured from prompt_eval_count + eval_count on the last reply."}
          </div>
        </div>
      )}

      <div className="rfoot">
        <span className="keepalive">
          {expiresAt === null ? "kept" : `keep_alive ${formatCountdown(expiresAt, nowMs)}`}
        </span>
        <span className="spacer" />
        <button type="button" className="btn xs" disabled={ejecting} onClick={handleEject}>
          {ejecting ? "…" : "Eject"}
        </button>
      </div>
    </div>
  );
}
