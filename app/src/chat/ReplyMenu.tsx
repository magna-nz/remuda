/**
 * The reply overflow menu (docs/SPEC-tuning.md T6 items 1–3, mockup-tuning
 * `#t6` card 2).
 *
 * Everything that acts on *one* reply lives here rather than as a row of
 * buttons under every bubble: promote it to `SYSTEM`, re-roll it, or leave
 * with the exact request that produced it.
 *
 * Two Regenerate items, not one. Holding the seed constant re-rolls the
 * *configuration*; changing it re-rolls the *sampling*. That distinction is
 * the whole reason the item exists, and collapsing it into one "Regenerate"
 * would hide the only interesting choice. When nothing pinned a seed there is
 * no constant to hold, so the first item says so instead of pretending.
 */
import { useEffect, useRef } from "react";
import "./ReplyMenu.css";

/**
 * Copy to the clipboard, with the pre-async-API fallback.
 *
 * `navigator.clipboard` is undefined outside a secure context and in jsdom;
 * failing silently there would make "Copy as curl" a button that does nothing
 * and says nothing, so the `execCommand` path stays as the fallback it was
 * designed to be.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path rather than reporting failure early.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export interface ReplyMenuProps {
  /** Distinguishes this menu from every other one on screen, e.g. "for lane A, turn 1". */
  name: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** The seed the reply's configuration names; null when nothing pinned one. */
  seed: number | null;
  /** Disabled while anything is generating — SPEC §8 is one run at a time. */
  busy: boolean;
  onPromote: () => void;
  /** Re-roll holding the configured seed — the config changes, the sampling doesn't. */
  onRegenerateSameSeed: () => void;
  /** Re-roll on a fresh seed — the sampling changes, the config doesn't. */
  onRegenerateNewSeed: () => void;
  onCopyCurl: () => void;
  onCopyOllamaRun: () => void;
}

export function ReplyMenu({
  name,
  open,
  onToggle,
  onClose,
  seed,
  busy,
  onPromote,
  onRegenerateSameSeed,
  onRegenerateNewSeed,
  onCopyCurl,
  onCopyOllamaRun,
}: ReplyMenuProps) {
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: MouseEvent) => {
      if (e.target instanceof Node && wrap.current?.contains(e.target) === true) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, onClose]);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <div className="replymenu" ref={wrap}>
      <button
        type="button"
        className="iconbtn"
        aria-label={`Reply actions ${name}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label={`Reply actions ${name}`}>
          <button type="button" role="menuitem" className="mi" onClick={run(onPromote)}>
            <span className="ic" aria-hidden="true">
              ⤴
            </span>
            Promote to SYSTEM
          </button>
          <div className="msep" />
          <button
            type="button"
            role="menuitem"
            className="mi"
            disabled={busy || seed === null}
            title={
              seed === null
                ? "No seed is set for this reply, so there is nothing to hold constant"
                : `Re-roll the configuration, holding seed ${seed}`
            }
            onClick={run(onRegenerateSameSeed)}
          >
            <span className="ic" aria-hidden="true">
              ↻
            </span>
            Regenerate
            <span className="kbd">{seed === null ? "no seed set" : `seed ${seed}`}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="mi"
            disabled={busy}
            title="Re-roll the sampling on a fresh seed"
            onClick={run(onRegenerateNewSeed)}
          >
            <span className="ic" aria-hidden="true">
              ↻
            </span>
            Regenerate
            <span className="kbd">new seed</span>
          </button>
          <div className="msep" />
          <button type="button" role="menuitem" className="mi" onClick={run(onCopyCurl)}>
            <span className="ic" aria-hidden="true">
              ⧉
            </span>
            Copy as curl
          </button>
          <button type="button" role="menuitem" className="mi" onClick={run(onCopyOllamaRun)}>
            <span className="ic" aria-hidden="true">
              ⧉
            </span>
            Copy as ollama run
          </button>
        </div>
      )}
    </div>
  );
}
