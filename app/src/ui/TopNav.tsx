/**
 * Global top nav (SPEC.md §5, §5.1): brand mark, the model control (opens
 * the load pane), and the connection pill.
 */
import "./TopNav.css";
import { useRemuda } from "./state";

function shortTag(tag: string): string {
  return tag.endsWith(":latest") ? tag.slice(0, -":latest".length) : tag;
}

function controlLabel(loaded: { base: string; variant: string } | null): string {
  if (!loaded) return "No model loaded";
  return loaded.variant === loaded.base
    ? `${loaded.base} · Original`
    : `${loaded.base} · ${shortTag(loaded.variant)}`;
}

export function TopNav() {
  const { status, loaded, loadPaneOpen, openLoadPane, closeLoadPane, openEditor } = useRemuda();

  return (
    <header className="titlebar">
      <div className="brand">
        <span className="mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l7 4v6c0 4-3 6-7 8-4-2-7-4-7-8V7z" />
          </svg>
        </span>
        <b>Remuda</b>
      </div>
      <div className="divider" />
      <button
        type="button"
        className="modelctl"
        title="Choose and load a model"
        aria-haspopup="dialog"
        aria-expanded={loadPaneOpen}
        onClick={() => (loadPaneOpen ? closeLoadPane() : openLoadPane())}
      >
        <span className={`d${loaded ? "" : " off"}`} aria-hidden="true" />
        <span className="mctl-t">{controlLabel(loaded)}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {loaded && (
        <button
          type="button"
          className="btn iconbtn edit-modelfile"
          title={`Edit ${loaded.variant}'s Modelfile`}
          aria-label={`Edit ${loaded.variant}'s Modelfile`}
          onClick={() => void openEditor(loaded.variant)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
        </button>
      )}
      <div className="spacer" />
      <div className={`conn${status.connected ? "" : " off"}`}>
        <span className="dot" aria-hidden="true" />
        <span>
          {status.connected ? (status.version ? `Connected · v${status.version}` : "Connected") : "Not running"}
        </span>
      </div>
    </header>
  );
}
