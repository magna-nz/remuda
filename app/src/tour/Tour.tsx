/**
 * The guided tour (docs/SPEC-round-two.md R6; mockup-proposals-2.html §06).
 *
 * A ring around the real control, everything else dimmed, and a card beside
 * it. Five steps, and the three rules that shape the code:
 *
 * - **Offered, never forced.** Nothing here mounts until someone presses a
 *   button — the first-run card, or Settings → Run the tour.
 * - **A missing target is skipped, never wedged.** Two of the five steps
 *   point at controls that only exist once there is a chat or a draft. On a
 *   first launch with Ollama not installed they are simply not there, and
 *   the tour steps over them and says "of 3" rather than "of 5". Lying about
 *   the count would be the smaller bug; stopping on a step it cannot draw
 *   would be the larger one.
 * - **It leaves the app as it found it.** The view and editor segment at
 *   the moment it started are restored on the way out, so Settings → Run
 *   the tour returns you to Settings.
 *
 * Positioning is `position: fixed` against viewport coordinates, where the
 * mockup used `absolute` inside its fake window — the same geometry, minus
 * a positioned ancestor the real shell doesn't have.
 */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import "./Tour.css";
import { stopTour, useTourRunning } from "./controller";
import { CARD_WIDTH, placeCard, type Box } from "./place";
import { subscribeTourTargets, tourTarget, tourTargetVersion } from "./registry";
import { TOUR_STEPS, type TourStep, type TourStepId } from "./steps";
import { useRemuda, type EditorPane, type View } from "../ui/state";

/** Rough card height, for keeping it inside the viewport before it has one. */
const CARD_HEIGHT_ESTIMATE = 210;

function measure(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function sameBox(a: Box, b: Box): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** Everything inside the card that Tab can reach, in document order. */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
    ),
  );
}

/**
 * Arrow keys move between steps — except while the caret is in a field. The
 * spotlight does not block clicks (that is the point: it runs on the real
 * UI), so the user can be typing in the composer with the tour still up, and
 * swallowing their arrow keys there would be indefensible.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function Tour() {
  // The whole overlay is absent until it is running, so nothing subscribes,
  // measures or listens on a first launch nobody has opted into.
  return useTourRunning() ? <TourRun /> : null;
}

function TourRun() {
  const { view, setView, editorPane, setEditorPane } = useRemuda();
  const version = useSyncExternalStore(subscribeTourTargets, tourTargetVersion, tourTargetVersion);

  const [index, setIndex] = useState(0);
  /** Direction of travel: a skipped step keeps going the way the user was. */
  const [direction, setDirection] = useState<1 | -1>(1);
  const [skipped, setSkipped] = useState<readonly TourStepId[]>([]);
  // Read inside `goTo`, which must not re-create on every skip — the measure
  // effect depends on it and would loop.
  const skippedRef = useRef<readonly TourStepId[]>([]);
  skippedRef.current = skipped;
  const [box, setBox] = useState<Box | null>(null);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const resume = useRef<{ view: View; pane: EditorPane } | null>(null);
  const titleId = useId();

  const step: TourStep | undefined = TOUR_STEPS[index];

  const applyStep = useCallback(
    (next: TourStep) => {
      // Both are batched with the index change, so the target's component
      // has mounted and registered by the time the effect below looks for
      // it. If `setView` refuses (an unsaved draft declining to be left),
      // the target stays absent and the step is skipped — which is right:
      // the tour is not worth overriding a save prompt for.
      if (next.view !== undefined) setView(next.view);
      if (next.editorPane !== undefined) setEditorPane(next.editorPane);
    },
    [setView, setEditorPane],
  );

  /**
   * Set when the tour has run out of steps *having skipped some*.
   *
   * The offer promises five steps. On an empty app — no chat, no draft —
   * two of them have nothing to point at, and simply vanishing after the
   * third reads as the tour breaking. The closing card names what was
   * missing and how to reach it, which is information rather than an
   * apology.
   */
  const [closing, setClosing] = useState(false);

  const finish = useCallback(() => {
    const back = resume.current;
    if (back !== null) {
      setView(back.view);
      setEditorPane(back.pane);
    }
    stopTour();
  }, [setView, setEditorPane]);

  const goTo = useCallback(
    (next: number, dir: 1 | -1) => {
      if (next >= TOUR_STEPS.length) {
        // Forward off the end with skipped steps behind us: say so rather
        // than disappear. Backwards, and on an explicit Skip, `finish` is
        // called directly and this branch never runs.
        if (dir === 1 && skippedRef.current.length > 0) {
          setClosing(true);
          return;
        }
        finish();
        return;
      }
      const target = TOUR_STEPS[next];
      if (target === undefined) return; // next < 0; the caller has already guarded it.
      setDirection(dir);
      setIndex(next);
      setBox(null);
      applyStep(target);
    },
    [applyStep, finish],
  );

  // Where the tour found the app, and step one. Runs once: `running` only
  // becomes true from a click, so this mount is never StrictMode's doubled
  // initial one.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    resume.current = { view, pane: editorPane };
    const first = TOUR_STEPS[0];
    if (first !== undefined) applyStep(first);
  }, [view, editorPane, applyStep]);

  // Measure, or skip. The registry version is a dependency so a target that
  // mounts a beat late (an async editor load) is picked up rather than
  // missed — and one that unmounts under the tour is skipped rather than
  // left as a ring around nothing.
  useEffect(() => {
    if (step === undefined) return;
    const el = tourTarget(step.id);
    if (el !== null) {
      // Replaced only when it has actually moved: a fresh object on every
      // re-measure would pull focus back into the card each time.
      const next = measure(el);
      setBox((prev) => (prev !== null && sameBox(prev, next) ? prev : next));
      // jsdom has no scrollIntoView; the guard is for the test environment,
      // not for any browser.
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      return;
    }
    setSkipped((prev) => (prev.includes(step.id) ? prev : [...prev, step.id]));
    if (index + direction < 0) {
      // Back off the front of a step that isn't there: go forward instead of
      // stopping on a spotlight with nothing under it.
      goTo(index + 1, 1);
      return;
    }
    goTo(index + direction, direction);
  }, [step, index, direction, version, goTo]);

  // A window that changes size moves the target; the ring has to follow it.
  useEffect(() => {
    if (step === undefined) return;
    const update = () => {
      const el = tourTarget(step.id);
      if (el !== null) setBox(measure(el));
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step]);

  const shown = TOUR_STEPS.filter((s) => !skipped.includes(s.id));
  const position = step === undefined ? 0 : shown.findIndex((s) => s.id === step.id) + 1;
  const isLast = index === TOUR_STEPS.length - 1;
  // Not `index > 0`: with step one skipped there is nothing behind step two
  // either, and an enabled Back that bounces straight forward again is worse
  // than a disabled one.
  const canGoBack = position > 1;

  // Focus lands in the card on every step, so the keyboard has somewhere to
  // be and a screen reader reads the new step rather than staying wherever
  // the last click left it.
  useEffect(() => {
    // `closing` is in the deps because the closing card replaces the step
    // card without touching `box` or `index` — without it, focus would be
    // left on the Next button that just unmounted, i.e. on nothing.
    if (box === null && !closing) return;
    cardRef.current?.focus();
  }, [box, index, closing]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
        return;
      }
      if (e.key === "Tab") {
        const card = cardRef.current;
        if (card === null) return;
        const items = focusables(card);
        const first = items[0];
        const last = items[items.length - 1];
        if (first === undefined || last === undefined) {
          e.preventDefault();
          card.focus();
          return;
        }
        const active = document.activeElement;
        const at = active instanceof HTMLElement ? items.indexOf(active) : -1;
        if (e.shiftKey ? at <= 0 : at === -1 || at === items.length - 1) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
        return;
      }
      if (isTextEntry(e.target)) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        goTo(index + 1, 1);
      } else if (e.key === "ArrowLeft") {
        if (!canGoBack) return;
        e.preventDefault();
        goTo(index - 1, -1);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, canGoBack, goTo, finish]);

  // The closing card: no spotlight, because it is about the app as a whole
  // rather than any one control. Centred, and it is the last thing the tour
  // does.
  if (closing) {
    const missed = TOUR_STEPS.filter((s) => skipped.includes(s.id));
    return (
      <div
        className="tour-card tour-closing"
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="tc-b">
          <div className="tc-step">{`Saw ${shown.length} of ${TOUR_STEPS.length}`}</div>
          <h4 id={titleId}>That’s the tour</h4>
          <p>
            {missed.length === 1
              ? "One step had nothing to point at yet:"
              : "Some steps had nothing to point at yet:"}
          </p>
          <ul className="tour-missed">
            {missed.map((s) => (
              <li key={s.id}>
                <b>{s.title.split(" — ")[0]}</b>
                {s.missingNote === undefined ? null : ` — ${s.missingNote}`}
              </li>
            ))}
          </ul>
          <p className="tc-note">Run the tour again from Settings once you have a model loaded.</p>
        </div>
        <div className="tc-f">
          <span className="spacer" />
          <button type="button" className="btn sm primary" onClick={finish}>
            Done
          </button>
        </div>
      </div>
    );
  }

  // Between steps — the old target gone, the new one not measured yet — the
  // overlay draws nothing rather than a ring parked at the origin.
  if (step === undefined || box === null) return null;

  const card = placeCard(
    box,
    { width: window.innerWidth, height: window.innerHeight },
    cardRef.current?.offsetHeight || CARD_HEIGHT_ESTIMATE,
  );

  return (
    <>
      <div
        className="tour-spot"
        aria-hidden="true"
        style={{ left: box.left - 4, top: box.top - 4, width: box.width + 8, height: box.height + 8 }}
      />
      <div
        className="tour-card"
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ left: card.left, top: card.top, width: CARD_WIDTH }}
      >
        <div className="tc-b">
          <div className="tc-step">{`Step ${position} of ${shown.length}`}</div>
          <h4 id={titleId}>{step.title}</h4>
          <p>{step.body}</p>
        </div>
        <div className="tc-f">
          <span className="tour-dots" aria-hidden="true">
            {shown.map((s, i) => (
              <i key={s.id} className={i === position - 1 ? "on" : undefined} />
            ))}
          </span>
          <span className="spacer" />
          {!isLast && (
            <button type="button" className="btn ghost sm" onClick={finish}>
              Skip
            </button>
          )}
          <button
            type="button"
            className="btn sm"
            disabled={!canGoBack}
            onClick={() => goTo(index - 1, -1)}
          >
            Back
          </button>
          <button type="button" className="btn sm primary" onClick={() => goTo(index + 1, 1)}>
            {isLast ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </>
  );
}
