/**
 * The empty state (docs/SPEC-round-two.md R7 + R5 layer 1; the shape is
 * docs/mockup-proposals-2.html §05 layer 1).
 *
 * This is where "what does *benchmark* mean here" is answered. The best help
 * costs nothing to find because you cannot avoid it: nobody reaches a
 * benchmark without passing through this screen, so it says what the thing
 * is, why you'd use it, and the three steps to fill it. Then it says the one
 * rule that keeps it a tool rather than a scoreboard.
 *
 * R4's `BenchEmpty` answered the narrower question, "did my edit break
 * something I wasn't looking at". This one answers "which of these is better
 * for my prompts", which is the question people arrive with.
 */
import "./BenchmarkEmpty.css";
import { Term } from "../help/Term";

export function BenchmarkEmpty() {
  return (
    <div className="emptyfeat">
      <span className="ef-ic" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
        </svg>
      </span>
      <h3>
        A <Term name="benchmark">benchmark</Term> runs one set of prompts through several
        models side by side
      </h3>
      <p>
        Each lane is one configuration: a model and the <Term name="Modelfile">Modelfile</Term>{" "}
        it runs under. Every prompt goes to every lane, and the answers sit next to each other in
        one row, so you can read what the difference between two setups actually sounds like
        instead of guessing from the settings.
      </p>
      <ol className="ef-how">
        <li>
          <b>1</b>
          <span>
            Set up the lanes. Pick a model and a Modelfile for each. The same model with two
            different Modelfiles is the usual pair.
          </span>
        </li>
        <li>
          <b>2</b>
          <span>
            Add prompts from any chat, with <b className="ef-ui">Add to benchmark</b> on the
            message. Keep the ones you actually care about getting right.
          </span>
        </li>
        <li>
          <b>3</b>
          <span>
            Press <b className="ef-ui">Run all</b>. Every lane answers every prompt on one pinned{" "}
            <Term name="seed">seed</Term>, so what you are reading is the lanes and not the
            randomness.
          </span>
        </li>
      </ol>
      <p className="ef-note">
        Remuda diffs the answers. It never scores them, and it never says which lane won.
      </p>
    </div>
  );
}
