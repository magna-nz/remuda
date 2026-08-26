/**
 * Global top nav (SPEC.md §5, §5.1): brand mark, the model control (opens
 * the load pane), and the connection pill.
 */
import { useMemo } from "react";
import "./TopNav.css";
import { useRemuda } from "./state";
import { displayKey, groupByModel, type ModelEntry } from "../models/grouping";

function shortTag(tag: string): string {
  return tag.endsWith(":latest") ? tag.slice(0, -":latest".length) : tag;
}

/**
 * The control names the same three things the load pane asked for: the model,
 * the quantisation, and the Modelfile. `loaded.base` is the quant's tag, so
 * the grouping (models/grouping.ts) is what turns it back into a model name —
 * falling back to the raw tag if this tag isn't in the list yet.
 */
function controlLabel(loaded: { base: string; variant: string } | null, entries: ModelEntry[]): string {
  if (!loaded) return "No model loaded";
  const tuning = loaded.variant === loaded.base ? "Original" : shortTag(loaded.variant);
  const entry = entries.find((e) => e.quants.some((q) => q.tag === loaded.base));
  const quant = entry?.quants.find((q) => q.tag === loaded.base);
  if (entry === undefined || quant === undefined) return `${loaded.base} · ${tuning}`;
  return [displayKey(entry.key), quant.quantization, tuning].filter((part) => part !== "").join(" · ");
}

export function TopNav() {
  const { status, loaded, loadPaneOpen, openLoadPane, closeLoadPane, openEditor, groups } = useRemuda();
  const entries = useMemo(() => groupByModel(groups), [groups]);

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
        <span className="mctl-t">{controlLabel(loaded, entries)}</span>
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
