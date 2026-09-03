/**
 * Disconnected banner (SPEC.md §9): shown whenever the health check
 * fails. The store polls every 5s; Retry re-runs the check immediately.
 *
 * "Start Ollama" spawns `ollama serve` via the Rust shell (SPEC-tuning.md T6,
 * item 4). Outside the desktop shell — a plain browser tab, or a test run —
 * `startOllama()` rejects rather than resolving silently
 * (`/desktop app/` in the message), so the click handler always catches. A
 * spawn failure (most commonly `ollama` missing from PATH) is shown verbatim:
 * that text is the only thing that tells the user what to fix, so it must
 * not be replaced with a generic "couldn't start".
 */
import { useState } from "react";
import "./OfflineBanner.css";
import { useRemuda } from "./state";
import { DEFAULT_BASE_URL } from "../api/types";
import { startOllama } from "../api/host";

export function OfflineBanner() {
  const { status, checked, checkHealth } = useRemuda();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Don't flash the banner before the first health check has resolved.
  if (!checked || status.connected) return null;

  function handleStart() {
    if (starting) return; // A double-click must not spawn a second process.
    setStarting(true);
    setStartError(null);
    startOllama()
      .catch((err: unknown) => {
        setStartError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setStarting(false);
      });
  }

  return (
    <div className="banner" role="alert">
      <svg className="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
        <path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
      <div className="bt">
        <b>Ollama isn&rsquo;t running.</b>
        <p>
          Remuda can&rsquo;t reach the server at <code>{DEFAULT_BASE_URL.replace(/^https?:\/\//, "")}</code>. Start it, then
          retry.
        </p>
        {startError !== null && <p>{startError}</p>}
      </div>
      <button type="button" className="btn sm" onClick={() => void checkHealth()}>
        Retry
      </button>
      <button type="button" className="btn sm primary" onClick={handleStart} disabled={starting}>
        {starting ? "Starting…" : "Start Ollama"}
      </button>
    </div>
  );
}
