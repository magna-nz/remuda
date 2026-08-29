/**
 * The empty state (docs/SPEC-round-two.md R5 layer 1; the copy and the shape
 * are docs/mockup-proposals-2.html §05 layer 1).
 *
 * This is where "what does *bench* mean" is answered. The best help costs
 * nothing to find because you cannot avoid it: nobody reaches a bench
 * without passing through this screen, so it says what the thing is, why
 * you'd use it, and the three steps to fill it — and then says the one rule
 * that keeps it a tool rather than a scoreboard.
 *
 * Written as plain markup on purpose. R5's `<PaneHelp>` / `<Term>` layer is
 * another agent's wiring; nothing here imports from app/src/help/ yet.
 */
import "./BenchEmpty.css";

export function BenchEmpty() {
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
          <path d="M9 3v4M15 3v4M4 9h16M6 9v10a2 2 0 002 2h8a2 2 0 002-2V9" />
          <path d="M9 14h6" />
        </svg>
      </span>
      <h3>A bench is a set of prompts you re-run after a change</h3>
      <p>
        Every edit to a Modelfile changes <em>all</em> of a model&rsquo;s behaviour, not just the
        part you were working on. A bench replays your saved prompts against the new version and
        shows you which answers moved — so you notice the thing you weren&rsquo;t looking at.
      </p>
      <ol className="ef-how">
        <li>
          <b>1</b>
          <span>
            Find a prompt worth keeping in any chat, and choose <b className="ef-ui">Add to bench</b>{" "}
            on the message.
          </span>
        </li>
        <li>
          <b>2</b>
          <span>
            Save a Modelfile, then press <b className="ef-ui">Run all</b>. Every prompt runs on one
            pinned seed.
          </span>
        </li>
        <li>
          <b>3</b>
          <span>
            Read only the rows badged <b className="ef-ui">Changed</b>. The rest answered the same
            as last time.
          </span>
        </li>
      </ol>
      <p className="ef-note">Remuda diffs the answers. It never scores them.</p>
    </div>
  );
}
