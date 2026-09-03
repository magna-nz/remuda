/**
 * The memory question asked before a run loads anything
 * (docs/mockup-new-menu.html §05).
 *
 * It opens **only** when a lane collides with something already resident —
 * a dialog that also appears to say "fine" trains people to dismiss it
 * unread. Everything else it could say (a lane reusing resident weights, a
 * lane that fits, a lane nobody could predict) is shown on the lane row as
 * you edit, not here.
 *
 * `Run anyway` is deliberate: `predictFit` is an estimate with a documented
 * f16 KV assumption, and the user may know something it doesn't. Ollama's
 * own error is a better answer than Remuda's refusal, and `run.ts` rule 3
 * keeps a failed lane as a result rather than the end of the run.
 */
import { useEffect } from "react";
import "./RunPreflight.css";
import { formatSize } from "../ui/TopNav";
import { shortTag } from "../chat/sessions";
import type { Preflight } from "./preflight";

export interface RunPreflightProps {
  preflight: Preflight;
  /** Unload every blocker, then run. */
  onUnloadAndRun: () => void;
  /** Run untouched, and let the server say what happens. */
  onRunAnyway: () => void;
  onCancel: () => void;
}

export function RunPreflight({ preflight, onUnloadAndRun, onRunAnyway, onCancel }: RunPreflightProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const { blockers } = preflight;
  const freed = blockers.reduce((sum, b) => sum + b.sizeBytes, 0);
  const pinned = blockers.filter((b) => b.pinned);
  const names = blockers.map((b) => shortTag(b.tag));
  const subject = names.length === 1 ? names[0] ?? "" : `${String(names.length)} models`;

  return (
    <div className="rp-scrim" role="presentation">
      <div className="rp" role="dialog" aria-modal="true" aria-labelledby="rp-title">
        <div className="rp-h">
          <b id="rp-title">{`Unload ${subject} to run this?`}</b>
          <p>
            {names.length === 1
              ? `It's holding ${formatSize(freed)} from your chat. A lane needs more than what's left.`
              : `They're holding ${formatSize(freed)} between them. A lane needs more than what's left.`}
          </p>
        </div>

        <div className="rp-b">
          {preflight.lanes.map((verdict, i) => {
            const name = `Lane ${String(i + 1)} · ${shortTag(verdict.model)}`;
            if (verdict.kind === "collides") {
              return (
                <div className="rp-chk bad" key={verdict.laneId}>
                  <span className="st" aria-hidden="true">✕</span>
                  <span className="col">
                    <span className="ct">{name}</span>
                    <span className="cs">
                      {`${formatSize(verdict.laneBytes)} beside ${formatSize(verdict.residentBytes)} resident is `}
                      <b>{formatSize(verdict.laneBytes + verdict.residentBytes)}</b>
                      {` against ${formatSize(verdict.usableBytes)} usable.`}
                    </span>
                  </span>
                </div>
              );
            }
            if (verdict.kind === "too-big") {
              return (
                <div className="rp-chk bad" key={verdict.laneId}>
                  <span className="st" aria-hidden="true">✕</span>
                  <span className="col">
                    <span className="ct">{name}</span>
                    {/* Unloading would not save this one, so it is named as a
                        separate problem rather than folded into the fix. */}
                    <span className="cs">
                      {`${formatSize(verdict.laneBytes)} against ${formatSize(verdict.usableBytes)} usable — `}
                      <b>too big on its own</b>. Unloading won&apos;t help.
                    </span>
                  </span>
                </div>
              );
            }
            const label =
              verdict.kind === "reuse"
                ? "Already in memory — reused, nothing loads."
                : verdict.kind === "unknown"
                  ? `Couldn't be predicted — ${verdict.reason}.`
                  : "Fits alongside what's resident.";
            return (
              <div className={verdict.kind === "unknown" ? "rp-chk unk" : "rp-chk ok"} key={verdict.laneId}>
                <span className="st" aria-hidden="true">{verdict.kind === "unknown" ? "?" : "✓"}</span>
                <span className="col">
                  <span className="ct">{name}</span>
                  <span className="cs">{label}</span>
                </span>
              </div>
            );
          })}

          {pinned.length > 0 && (
            <p className="rp-pin">
              {pinned.length === 1
                ? `${shortTag(pinned[0]?.tag ?? "")} is pinned — unloading clears the pin.`
                : "Some of these are pinned — unloading clears the pin."}{" "}
              Your chats are untouched; the next message loads the model again.
            </p>
          )}
        </div>

        <div className="rp-f">
          <button type="button" className="btn sm ghost" onClick={onRunAnyway}>
            Run anyway
          </button>
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn sm primary" onClick={onUnloadAndRun}>
            {`Unload and run · frees ${formatSize(freed)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
