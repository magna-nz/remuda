/**
 * The model question for "+ New ▸ New chat" (docs/mockup-new-menu.html §03).
 *
 * A session is bound to one model for its life (SPEC §5.2), so starting one
 * needs a model. This asks — but **only when the answer is ambiguous**:
 *
 *   none resident      → the installed list, "Load and start chat"
 *   exactly one        → never opens (the caller doesn't mount it)
 *   two or more        → the resident list, `activeModel` preselected
 *
 * The two-or-more case preselects the same model `newChat()` would have
 * bound to on its own, so Enter reproduces the old behaviour exactly: the
 * picker costs a keystroke, not a decision.
 *
 * SPEC §5.1's rule survives — nothing loads until a button is pressed. The
 * primary button *is* that press; opening this loads nothing.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import "./ModelPicker.css";
import { useRemuda } from "./state";
import { formatSize } from "./TopNav";
import { shortTag } from "../chat/sessions";
import { sameTag } from "../models/tags";

export interface ModelPickerProps {
  /** Preselected tag — the caller passes `activeModel`. */
  preselect: string | null;
  onCancel: () => void;
  /** The chosen tag, already resident by the time this fires. */
  onChoose: (tag: string) => void;
}

/** Two letters for the row's glyph, as LoadPane does it. */
function glyph(tag: string): string {
  const head = tag.split(":")[0] ?? tag;
  return head.slice(0, 2).toUpperCase();
}

export function ModelPicker({ preselect, onCancel, onChoose }: ModelPickerProps) {
  const { models, loaded, running, load } = useRemuda();
  const residentTags = useMemo(() => new Set(loaded.map((l) => l.variant)), [loaded]);

  // "Browsing" is the escape hatch: with models resident, offer the full
  // installed list too, because "a chat with a model that isn't loaded"
  // otherwise has no path from this menu — the dead end this whole change
  // exists to remove.
  const [browsing, setBrowsing] = useState(residentTags.size === 0);
  const askingToLoad = residentTags.size === 0 || browsing;

  const rows = useMemo(() => {
    const list = askingToLoad ? models : models.filter((m) => residentTags.has(m.tag));
    return [...list].sort((a, b) => b.sizeBytes - a.sizeBytes);
  }, [models, residentTags, askingToLoad]);

  const [chosen, setChosen] = useState<string | null>(
    () => (preselect !== null && residentTags.has(preselect) ? preselect : null),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Fall back to the first row whenever the list changes under a selection
  // that is no longer in it (switching to the installed list, mainly).
  const selected = chosen !== null && rows.some((m) => m.tag === chosen) ? chosen : rows[0]?.tag ?? null;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || loading) return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, loading]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const confirm = async () => {
    if (selected === null) return;
    if (residentTags.has(selected)) {
      onChoose(selected);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await load(selected);
      onChoose(selected);
    } catch (err) {
      // Stay open with the reason, rather than dumping the user into an empty
      // chat bound to a model that never loaded.
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  /**
   * Arrow and Enter handling lives on the **dialog**, not on the list.
   *
   * The dialog is what has focus when this opens, and keydown bubbles up from
   * the focused element — a handler on the list, which is a child, would
   * never see the first Down anyone presses. That made the arrows dead until
   * a row had been clicked, which is the one case where they were not needed.
   */
  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (loading || empty) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void confirm();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const at = rows.findIndex((m) => m.tag === selected);
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    const row = rows[(next + rows.length) % rows.length];
    if (row) setChosen(row.tag);
  };

  const empty = rows.length === 0;

  return (
    <div className="mp-scrim" role="presentation">
      <div
        className="mp"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mp-title"
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <div className="mp-h">
          <b id="mp-title">{askingToLoad ? "Load a model" : "Which model?"}</b>
          <p>
            {empty
              ? "No models are installed yet."
              : askingToLoad
                ? "Nothing is in memory yet. Pick one to load — this chat will be bound to it."
                : `${String(rows.length)} models are in memory. Pick the one this chat talks to.`}
          </p>
        </div>

        <div className="mp-b" role="radiogroup" aria-label="Models">
          {empty ? (
            <p className="mp-empty">Nothing to choose from — get a model first.</p>
          ) : (
            <>
              <div className="mp-group">
                {askingToLoad ? "Installed" : "In memory"}
                <span className="rule" />
              </div>
              {rows.map((m) => {
                const entry = running.find((r) => sameTag(r.tag, m.tag)) ?? null;
                const isResident = residentTags.has(m.tag);
                return (
                  <button
                    key={m.tag}
                    type="button"
                    role="radio"
                    aria-checked={m.tag === selected}
                    className="mp-row"
                    disabled={loading}
                    onClick={() => setChosen(m.tag)}
                    onDoubleClick={() => void confirm()}
                  >
                    <span className="gl" aria-hidden="true">{glyph(m.tag)}</span>
                    <span className="col">
                      <span className="mtag">{shortTag(m.tag)}</span>
                      <span className="sub">
                        {isResident && <span className="dot" aria-hidden="true" />}
                        {formatSize(entry?.sizeBytes ?? m.sizeBytes)}
                        {isResident ? " · in memory" : ""}
                      </span>
                    </span>
                    <span className="tick" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    </span>
                  </button>
                );
              })}

              {/* No endpoint reports OLLAMA_MAX_LOADED_MODELS, so this states
                  the fact and claims no number — the same rule predictFit
                  holds itself to. */}
              {askingToLoad && residentTags.size > 0 && (
                <p className="mp-evict">
                  Loading another may evict a model already in memory. Ollama decides which, and
                  doesn&apos;t report its limit.
                </p>
              )}

              {!askingToLoad && (
                <>
                  <div className="mp-group">
                    Not in memory
                    <span className="rule" />
                  </div>
                  <button type="button" className="mp-more" onClick={() => setBrowsing(true)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    Load a different model…
                  </button>
                </>
              )}
            </>
          )}
        </div>

        {error !== null && <p className="mp-error" role="alert">{error}</p>}

        <div className="mp-f">
          <span className="note">{loading ? "Loading…" : ""}</span>
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={onCancel} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="btn sm primary"
            onClick={() => void confirm()}
            disabled={empty || loading || selected === null}
          >
            {askingToLoad ? "Load and start chat" : "Start chat"}
          </button>
        </div>
      </div>
    </div>
  );
}
