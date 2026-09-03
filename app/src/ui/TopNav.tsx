/**
 * Global top nav (SPEC.md §5, §5.1): brand mark, the model control (opens
 * the load pane), the runtime chips (SPEC-tuning T7 — opens the Runtime
 * popover) and the connection pill.
 */
import { useEffect, useMemo, useState } from "react";
import "./TopNav.css";
import { useRemuda } from "./state";
import { RuntimePopover } from "./RuntimePopover";
import { displayKey, groupByModel, type ModelEntry } from "../models/grouping";
import type { RunningModel } from "../api/types";
import type { LoadedSelection } from "./state";
import { useTourTarget } from "../tour/registry";

function shortTag(tag: string): string {
  return tag.endsWith(":latest") ? tag.slice(0, -":latest".length) : tag;
}

/** Exported so `RuntimePopover.tsx` renders the same "5.6 GB" shape. */
export function formatSize(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * mm:ss countdown to `expiresAt`, floored at zero. Mirrors the approach in
 * `LoadPane.tsx`'s `formatCountdown` (a live tick gated on "something can
 * expire", never an always-on timer) but formatted as the mockup's bare
 * `4:52` rather than the load pane's "4m 52s" — the two surfaces show the
 * same fact at two different sizes, so the two owning files each keep their
 * own literal copy rather than importing across the LoadPane boundary.
 */
function formatCountdown(expiresAt: string, nowMs: number): string {
  const target = Date.parse(expiresAt);
  if (Number.isNaN(target)) return "—";
  const remainingSec = Math.max(0, Math.floor((target - nowMs) / 1000));
  const m = Math.floor(remainingSec / 60);
  const s = remainingSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
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

/** The VRAM/RAM split behind the placement chip. */
interface Placement {
  vramBytes: number;
  ramBytes: number;
  spilling: boolean;
}

/**
 * The placement chip's source figure (SPEC-tuning T7, correcting SPEC §5.1's
 * old `100% GPU` label): `size_vram / size` off `/api/ps`, meaning *where
 * the weights sit*, never GPU utilisation. Across several models it's the
 * pooled split, so the chip goes amber the moment *any* of them spills —
 * which is the case worth interrupting for. `sizeBytes === 0` contributes
 * nothing rather than dividing by zero, and an all-zero readout renders
 * nothing at all: the caller treats a null return as "say nothing".
 */
function placementOf(running: RunningModel[], loaded: LoadedSelection[]): Placement | null {
  let total = 0;
  let vram = 0;
  for (const sel of loaded) {
    const entry = running.find((r) => r.tag === sel.variant);
    if (!entry) continue;
    total += entry.sizeBytes;
    vram += entry.sizeVramBytes;
  }
  if (total === 0) return null;
  const ramBytes = Math.max(0, total - vram);
  return { vramBytes: vram, ramBytes, spilling: ramBytes > 0 };
}

/**
 * `● all on GPU · 5.6 GB` when every byte sits in VRAM, or the split itself
 * — `28.4 GB GPU + 9.1 GB RAM` — once anything has spilled. The split
 * replaces the percentage rather than sitting beside it (SPEC-tuning T7's
 * naming-collision fix): a placement percentage reads as utilisation, and it
 * isn't one.
 */
function placementLabel(p: Placement): string {
  return p.spilling
    ? `${formatSize(p.vramBytes)} GPU + ${formatSize(p.ramBytes)} RAM`
    : `all on GPU · ${formatSize(p.vramBytes)}`;
}

/** `ctx 8,192` before the window has been touched; `ctx 3,104/8,192` after. */
function ctxChipLabel(used: number | null, windowSize: number): { label: string; amber: boolean } {
  if (used === null) {
    return { label: `ctx ${windowSize.toLocaleString("en-US")}`, amber: false };
  }
  const pct = used / windowSize;
  return {
    label: `ctx ${used.toLocaleString("en-US")}/${windowSize.toLocaleString("en-US")}`,
    amber: pct >= 0.9,
  };
}

export function TopNav() {
  const {
    status,
    loaded,
    activeModel,
    loadPaneOpen,
    openLoadPane,
    closeLoadPane,
    openEditor,
    groups,
    running,
    lastStats,
    activeSessionId,
  } = useRemuda();
  const entries = useMemo(() => groupByModel(groups), [groups]);
  const placement = placementOf(running, loaded);
  const runningEntry = activeModel ? running.find((r) => r.tag === activeModel.variant) ?? null : null;
  const expiresAt = runningEntry?.expiresAt ?? null;
  const contextWindow = runningEntry?.contextLength ?? null;

  const [popoverOpen, setPopoverOpen] = useState(false);
  // R6 step 1's target. The tour reads the live element off the registry;
  // this is the whole of the registration.
  const modelCtlRef = useTourTarget("model-control");

  // Context occupancy belongs to the active session's last reply (SPEC-tuning
  // T7) — a different session's `lastStats` (or none yet) means "unknown",
  // never a stale or zeroed number.
  const contextUsed =
    lastStats !== null && lastStats.sessionId === activeSessionId ? lastStats.contextTokens : null;
  const ctxChip = contextWindow !== null ? ctxChipLabel(contextUsed, contextWindow) : null;

  // The keep_alive countdown ticks once a second, and only while the active
  // model actually has an expiry to count down to — mirrors LoadPane's own
  // guard rather than running an always-on timer.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

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
        ref={modelCtlRef}
        title="Choose and load a model"
        aria-haspopup="dialog"
        aria-expanded={loadPaneOpen}
        onClick={() => (loadPaneOpen ? closeLoadPane() : openLoadPane())}
      >
        <span className={`d${loaded.length > 0 ? "" : " off"}`} aria-hidden="true" />
        <span className="mctl-t">{controlLabel(loaded, entries, running)}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {/*
       * Three chips, not seven (SPEC-tuning T7): placement, context used,
       * keep_alive. Each is its own button and all three open the same
       * Runtime popover — the pattern the app already uses twice (the model
       * control opens the load pane, the overrides pill opens run controls).
       * The wrapper is the popover's own anchor, so it stays positioned
       * under the chips rather than the whole titlebar.
       */}
      <div className="runtime-group">
      {placement !== null && (
        <button
          type="button"
          className={`rchip${placement.spilling ? " warn" : " good"}`}
          title="Runtime details"
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          onClick={() => setPopoverOpen((open) => !open)}
        >
          <span className="d" aria-hidden="true" />
          {placementLabel(placement)}
        </button>
      )}
      {ctxChip !== null && (
        <button
          type="button"
          className={`rchip${ctxChip.amber ? " warn" : ""}`}
          title="Runtime details"
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          onClick={() => setPopoverOpen((open) => !open)}
        >
          {ctxChip.label}
        </button>
      )}
      {expiresAt !== null && (
        <button
          type="button"
          className="rchip"
          title="Runtime details"
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          onClick={() => setPopoverOpen((open) => !open)}
        >
          {formatCountdown(expiresAt, nowMs)}
        </button>
      )}
      {popoverOpen && <RuntimePopover onClose={() => setPopoverOpen(false)} />}
      </div>
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
