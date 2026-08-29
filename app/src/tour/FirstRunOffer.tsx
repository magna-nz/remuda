/**
 * The first-run offer (docs/SPEC-round-two.md R6; mockup §06 `.firstrun`).
 *
 * A card in the flow of the shell — **not a modal**. It is the first thing a
 * new user sees, and the worst thing it could do is stand between them and
 * the app they just installed. Ignoring it entirely is a supported answer:
 * nothing is disabled behind it, nothing has to be dismissed first, and it
 * takes a strip of the window rather than the whole of it.
 *
 * Both buttons settle the offer, "Not now" included, because a card that
 * returns every launch has stopped being an offer and become a nag. Settings
 * → Run the tour is where it lives afterwards.
 */
import { useEffect, useState } from "react";
import "./Tour.css";
import { startTour, useTourRunning } from "./controller";
import { dismissFirstRunOffer, isFirstRunOfferDismissed, subscribeTourOffer } from "./persistence";

export function FirstRunOffer() {
  const [dismissed, setDismissed] = useState(() => isFirstRunOfferDismissed());
  const running = useTourRunning();

  useEffect(() => subscribeTourOffer(() => setDismissed(isFirstRunOfferDismissed())), []);

  if (dismissed || running) return null;

  return (
    <section className="firstrun" aria-label="Take the tour">
      <span className="fr-ic" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 3l14 9-14 9V3z" />
        </svg>
      </span>
      <div className="fr-b">
        <b>First time here? Remuda in five steps.</b>
        <p>About two minutes. You can stop anywhere, and re-run it later from Settings.</p>
      </div>
      <button type="button" className="btn sm ghost" onClick={() => dismissFirstRunOffer()}>
        Not now
      </button>
      <button
        type="button"
        className="btn sm primary"
        onClick={() => {
          dismissFirstRunOffer();
          startTour();
        }}
      >
        Take the tour
      </button>
    </section>
  );
}
