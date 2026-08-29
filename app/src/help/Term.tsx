/**
 * `<Term>` — layer 3 of the help system (docs/SPEC-round-two.md R5,
 * docs/mockup-proposals-2.html §05).
 *
 * SPEC §4 already splits human words (Inter) from machine words (Plex Mono).
 * This makes every machine word a definition: dotted underline, and a
 * popover carrying the glossary entry.
 *
 * **It is never hover-only.** The trigger is a real `<button>`, so the
 * definition opens on hover, on keyboard focus *and* on click — hover-only
 * is unreachable from the keyboard and invisible on a touch screen, which
 * makes it help that only reaches the people who least need it. Escape
 * closes; a click outside closes; the button keeps a visible focus ring.
 *
 * A word missing from the glossary renders as plain text with no underline
 * and no button, rather than a control that opens nothing.
 *
 * `pinned` distinguishes a deliberate open (click) from a hover. Only a
 * click pins, and only a pinned popover survives the pointer leaving — see
 * the note on `onFocus` for why focus is deliberately not a pin.
 */
import { useEffect, useId, useRef, useState, type ReactNode, useLayoutEffect } from "react";
import "./Term.css";
import { availableHeight, placeTerm } from "./placeTerm";
import { lookupTerm } from "./glossary";

export interface TermProps {
  /**
   * The glossary key. Matched case-insensitively, so `KV cache` and
   * `kv cache` reach the same entry.
   */
  name: string;
  /**
   * What to show, when the surface spells the word differently from the
   * glossary key — `quantised` for the entry `quantise`. Defaults to the
   * entry's own spelling.
   */
  children?: ReactNode;
  /** Extra class on the trigger, for callers that need spacing overrides. */
  className?: string;
}

export function Term({ name, children, className }: TermProps) {
  const entry = lookupTerm(name);
  const popoverId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  /**
   * Viewport coordinates for the popover, measured once it has been laid
   * out. Null means "not placed yet", and the popover stays hidden for that
   * frame rather than flashing at the top-left corner.
   */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  /**
   * Whether the popover was opened deliberately — by click or by focus —
   * rather than by the pointer passing over it. A deliberate open survives
   * the pointer leaving; a hover does not.
   */
  const [pinned, setPinned] = useState(false);

  const close = () => {
    setOpen(false);
    setPinned(false);
  };

  // Measure and place before paint. `useLayoutEffect` rather than
  // `useEffect` so the popover is never painted at its unplaced position
  // first — that reads as a flicker at the corner of the window.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const wrap = wrapRef.current;
      const pop = popRef.current;
      if (wrap === null || pop === null) return;
      const rect = wrap.getBoundingClientRect();
      setPos(
        placeTerm(
          { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          { width: window.innerWidth, height: window.innerHeight },
          pop.offsetWidth,
          pop.offsetHeight,
        ),
      );
    };
    place();
    // Fixed coordinates do not follow the word, so anything that moves it
    // re-places rather than leaving the popover behind. Capture catches
    // scrolls in the pane, which do not bubble.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Escape closes from anywhere, not just from the trigger: the popover can
  // be open under the pointer while focus sits elsewhere entirely.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // A click elsewhere dismisses a pinned popover. Only while pinned — an
  // unpinned one is already following the pointer.
  useEffect(() => {
    if (!open || !pinned) return;
    const onPointerDown = (e: MouseEvent) => {
      const wrap = wrapRef.current;
      if (wrap !== null && e.target instanceof Node && wrap.contains(e.target)) return;
      close();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, pinned]);

  if (entry === undefined) return <span className={className}>{children ?? name}</span>;

  const label = children ?? entry.term;

  return (
    <span className="termwrap" ref={wrapRef}>
      <button
        type="button"
        className={className ? `term ${className}` : "term"}
        // `aria-describedby` is what puts the definition into a screen
        // reader's mouth: focus opens the popover, and the description is
        // announced with the word rather than instead of it.
        aria-describedby={open ? popoverId : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => {
          if (!pinned) setOpen(false);
        }}
        // Focus opens but does not *pin*. A mouse click on an unfocused
        // trigger arrives as mouseEnter → focus → click; if focus pinned,
        // the click that followed would read as a second click and close
        // the popover the user was trying to open. Keyboard focus needs no
        // pin — it holds the popover open for exactly as long as it lasts,
        // and blur closes it.
        onFocus={() => setOpen(true)}
        onBlur={close}
        onClick={() => {
          if (open && pinned) close();
          else {
            setOpen(true);
            setPinned(true);
          }
        }}
      >
        {label}
      </button>
      {open && (
        <span
          className="termpop"
          id={popoverId}
          role="tooltip"
          ref={popRef}
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            maxHeight: availableHeight({ width: window.innerWidth, height: window.innerHeight }),
            visibility: pos === null ? "hidden" : undefined,
          }}
        >
          <b>{entry.term}</b>
          <span className="tp-def">{entry.definition}</span>
          {entry.extra !== undefined && <span className="tp-more">{entry.extra}</span>}
        </span>
      )}
    </span>
  );
}
