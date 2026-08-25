/**
 * Disconnected banner (SPEC.md §9): shown whenever the health check
 * fails. The store polls every 5s; Retry re-runs the check immediately.
 */
import "./OfflineBanner.css";
import { useRemuda } from "./state";
import { DEFAULT_BASE_URL } from "../api/types";

export function OfflineBanner() {
  const { status, checked, checkHealth } = useRemuda();

  // Don't flash the banner before the first health check has resolved.
  if (!checked || status.connected) return null;

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
      </div>
      <button type="button" className="btn sm" onClick={() => void checkHealth()}>
        Retry
      </button>
    </div>
  );
}
