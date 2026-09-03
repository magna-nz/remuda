/**
 * The reasoning stream, folded away (docs/mockup-proposals.html §03).
 *
 * Ollama streams reasoning in its own field (`message.thinking`), and the
 * store accumulates it into ChatMessage.thinking — never into `content`.
 * This block renders it *outside and above* the assistant bubble, in its own
 * muted container, so it reads as machinery rather than as the answer and
 * copying the reply doesn't drag the reasoning along.
 *
 * Collapsed by default; expanded and live while it streams.
 *
 * On duration: it is measured here, as wall time between the first render
 * with `live` and the render where `live` drops. A session restored from
 * localStorage has the reasoning text but no timing — nothing recorded one —
 * so it gets the neutral header "Reasoning" instead of an invented number.
 */
import { useEffect, useRef, useState } from "react";
import "./ThinkingBlock.css";

export interface ThinkingBlockProps {
  /** Accumulated reasoning text. */
  text: string;
  /** True while this reply is still streaming into the session. */
  live: boolean;
}

/** Live timer resolution — fine enough to read as a clock, cheap enough to ignore. */
const TICK_MS = 100;

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

export function ThinkingBlock({ text, live }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false);
  // null until this component has actually watched a stream: we time what we
  // saw, and say nothing about what we didn't.
  const [elapsedSec, setElapsedSec] = useState<number | null>(null);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!live) return;
    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }
    const started = startedAtRef.current;
    const tick = () => setElapsedSec((Date.now() - started) / 1000);
    tick();
    const id = window.setInterval(tick, TICK_MS);
    // Clearing on the live→false transition freezes the last reading, which
    // is the final duration.
    return () => window.clearInterval(id);
  }, [live]);

  const expanded = live || open;
  const header = live
    ? `Thinking… ${formatSeconds(elapsedSec ?? 0)}`
    : elapsedSec === null
      ? "Reasoning"
      : `Thought for ${formatSeconds(elapsedSec)}`;

  return (
    <div className={`think${expanded ? " open" : ""}${live ? " live" : ""}`}>
      <button
        type="button"
        className="think-h"
        aria-expanded={expanded}
        // While it streams the block stays open — there is nothing to fold
        // away yet, and folding a moving target reads as a glitch.
        disabled={live}
        onClick={() => setOpen((v) => !v)}
      >
        {live ? (
          <span className="rspin" aria-hidden="true" />
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9.7 17h4.6M12 3a6 6 0 0 0-3.6 10.8c.5.4.8 1 .8 1.6v.6h5.6v-.6c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3z" />
          </svg>
        )}
        <span>{header}</span>
        {!live && (
          <span className="chev" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
        )}
      </button>
      {expanded && (
        <div className="think-b">
          {text}
          {live && <span className="caret" aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}
