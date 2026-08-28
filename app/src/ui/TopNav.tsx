/**
 * Global top nav (SPEC.md §5, §5.1): brand mark, the model control (opens
 * the load pane), and the connection pill.
 */
import { useMemo } from "react";
import "./TopNav.css";
import { useRemuda } from "./state";
import { displayKey, groupByModel, type ModelEntry } from "../models/grouping";
import type { RunningModel } from "../api/types";
import type { LoadedSelection } from "./state";

function shortTag(tag: string): string {
  return tag.endsWith(":latest") ? tag.slice(0, -":latest".length) : tag;
}

function formatSize(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * The control names the same three things the load pane asked for: the model,
 * the quantisation, and the Modelfile. `sel.base` is the quant's tag, so
 * the grouping (models/grouping.ts) is what turns it back into a model name —
 * falling back to the raw tag if this tag isn't in the list yet.
 */
function oneModelLabel(sel: LoadedSelection, entries: ModelEntry[]): string {
  const tuning = sel.variant === sel.base ? "Original" : shortTag(sel.variant);
  const entry = entries.find((e) => e.quants.some((q) => q.tag === sel.base));
  const quant = entry?.quants.find((q) => q.tag === sel.base);
  if (entry === undefined || quant === undefined) return `${sel.base} · ${tuning}`;
  return [displayKey(entry.key), quant.quantization, tuning].filter((part) => part !== "").join(" · ");
}

/**
 * With one model resident the control names it, exactly as it always has.
 * With several, no single name is true — so it counts them and totals the
 * memory, which is the number that decides whether another one will fit.
 */
function controlLabel(loaded: LoadedSelection[], entries: ModelEntry[], running: RunningModel[]): string {
  const first = loaded[0];
  if (first === undefined) return "No model loaded";
  if (loaded.length === 1) return oneModelLabel(first, entries);
  const total = loaded.reduce(
    (sum, l) => sum + (running.find((r) => r.tag === l.variant)?.sizeBytes ?? 0),
    0,
  );
  const size = total > 0 ? ` · ${formatSize(total)}` : "";
  return `${loaded.length} models${size}`;
}

/**
 * The answer-at-a-glance chip (SPEC §5.1, mockup-proposals.html §01): what
 * fraction of resident weights sits in VRAM. Across several models it's the
 * pooled figure, so the chip goes amber the moment *any* of them spills —
 * which is the case worth interrupting for. `sizeBytes === 0` contributes
 * nothing rather than dividing by zero, and an all-zero readout renders no
 * percentage at all: the caller treats a null return as "say nothing".
 */
function gpuPercent(running: RunningModel[], loaded: LoadedSelection[]): number | null {
  let total = 0;
  let vram = 0;
  for (const sel of loaded) {
    const entry = running.find((r) => r.tag === sel.variant);
    if (!entry) continue;
    total += entry.sizeBytes;
    vram += entry.sizeVramBytes;
  }
  if (total === 0) return null;
  return Math.round((vram / total) * 100);
}

export function TopNav() {
  const { status, loaded, activeModel, loadPaneOpen, openLoadPane, closeLoadPane, openEditor, groups, running } =
    useRemuda();
  const entries = useMemo(() => groupByModel(groups), [groups]);
  const pct = gpuPercent(running, loaded);

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
        <span className={`d${loaded.length > 0 ? "" : " off"}`} aria-hidden="true" />
        <span className="mctl-t">{controlLabel(loaded, entries, running)}</span>
        {pct !== null && (
          <span className={`rt-inline${pct < 100 ? " spill" : ""}`}>{pct}% GPU</span>
        )}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {activeModel && (
        <button
          type="button"
          className="btn iconbtn edit-modelfile"
          title={`Edit ${activeModel.variant}'s Modelfile`}
          aria-label={`Edit ${activeModel.variant}'s Modelfile`}
          onClick={() => void openEditor(activeModel.variant)}
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
