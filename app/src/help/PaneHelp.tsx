/**
 * `<PaneHelp>` — layer 2 of the help system (docs/SPEC-round-two.md R5,
 * docs/mockup-proposals-2.html §05).
 *
 * A `?` in a pane header toggling an explainer **inline**: it sits in normal
 * flow and pushes the pane down, so it can never cover the thing it is
 * describing and a stray click can never dismiss it. That is the whole
 * reason it is not a popover — a floating panel about a surface obscures the
 * surface, and the reader has to choose between the explanation and the
 * thing being explained.
 *
 * Always the same three beats: **what it is**, **why you'd use it**, **how**
 * — the last as numbered steps. Plus an optional closing note for the caveat
 * that would otherwise become a fourth paragraph nobody reads.
 *
 * Open/closed persists per `paneId` (persistence.ts). A pane nobody has
 * dismissed is **open**, so the explainer is offered without anyone having
 * to discover the `?` first; closing it is remembered until Settings →
 * Reopen all.
 *
 * The `?` is exported separately as `<PaneHelpToggle>` because it belongs in
 * the pane's own header, which is not this component's markup. The two share
 * state through the store rather than through props, so a pane header does
 * not have to own or thread a boolean.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import "./PaneHelp.css";
import { isPaneHelpOpen, setPaneHelpOpen, subscribeHelp } from "./persistence";

/** The DOM id of a pane's strip — the `aria-controls` target of its `?`. */
export function paneHelpDomId(paneId: string): string {
  return `panehelp-${paneId}`;
}

/**
 * One pane's help state, live across every component showing it: the header
 * `?`, the strip's `✕`, and Settings → Reopen all.
 */
export function usePaneHelp(paneId: string): {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
} {
  const [open, setOpenLocal] = useState(() => isPaneHelpOpen(paneId));

  useEffect(() => {
    // Re-read on mount as well as on change: `paneId` may have changed since
    // the initial state was computed, and another component may have written
    // in between.
    setOpenLocal(isPaneHelpOpen(paneId));
    return subscribeHelp(() => setOpenLocal(isPaneHelpOpen(paneId)));
  }, [paneId]);

  const setOpen = useCallback((next: boolean) => setPaneHelpOpen(paneId, next), [paneId]);
  // Reads the store rather than the render's `open` so two toggles in one
  // tick can't disagree about what they are toggling from.
  const toggle = useCallback(() => setPaneHelpOpen(paneId, !isPaneHelpOpen(paneId)), [paneId]);

  return { open, setOpen, toggle };
}

export interface PaneHelpToggleProps {
  /** The same stable id the pane's `<PaneHelp>` is given. */
  paneId: string;
  /** Accessible name. Defaults to "About this pane". */
  label?: string;
  /** Extra class, for headers that need spacing overrides. */
  className?: string;
}

/** The `?` button. Lives in the pane header, beside the pane's own controls. */
export function PaneHelpToggle({ paneId, label = "About this pane", className }: PaneHelpToggleProps) {
  const { open, toggle } = usePaneHelp(paneId);
  return (
    <button
      type="button"
      className={[className, "qbtn", open ? "on" : null].filter(Boolean).join(" ")}
      aria-label={label}
      aria-expanded={open}
      aria-controls={paneHelpDomId(paneId)}
      title={label}
      onClick={toggle}
    >
      ?
    </button>
  );
}

/** The default strip icon: a pair of braces, the machine-word glyph. */
function DefaultIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 4H6a2 2 0 00-2 2v4l-2 2 2 2v4a2 2 0 002 2h2M16 4h2a2 2 0 012 2v4l2 2-2 2v4a2 2 0 01-2 2h-2" />
    </svg>
  );
}

export interface PaneHelpProps {
  /** Stable across renders and releases — it is the persistence key. */
  paneId: string;
  /** The strip's heading, e.g. "Format — force the reply into a shape". */
  title: string;
  /** Beat one: what this pane is. */
  what: ReactNode;
  /** Beat two: why you would use it. */
  why: ReactNode;
  /** Beat three: how, as numbered steps. Three is the house length. */
  steps: ReactNode[];
  /** The closing caveat, if there is one. */
  note?: ReactNode;
  /** A pane-specific glyph. Defaults to the braces above. */
  icon?: ReactNode;
}

export function PaneHelp({ paneId, title, what, why, steps, note, icon }: PaneHelpProps) {
  const { open, setOpen } = usePaneHelp(paneId);
  if (!open) return null;

  return (
    /* In flow, not floating: no `position` on this element, by design. */
    <section className="helpstrip" id={paneHelpDomId(paneId)} aria-label={`About ${title}`}>
      <span className="hs-ic">{icon ?? <DefaultIcon />}</span>
      <div className="hs-b">
        <h4>{title}</h4>
        <p>{what}</p>
        <p>{why}</p>
        {steps.length > 0 && (
          <ol className="helpsteps">
            {steps.map((step, i) => (
              // Static copy, authored in order: the index is the identity.
              <li key={i}>
                <b>{i + 1}</b>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        )}
        {note !== undefined && <p className="note">{note}</p>}
      </div>
      <button
        type="button"
        className="qbtn hs-x"
        aria-label={`Close help for ${title}`}
        title="Close"
        onClick={() => setOpen(false)}
      >
        ✕
      </button>
    </section>
  );
}
