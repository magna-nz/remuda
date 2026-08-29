/**
 * Pull view (SPEC.md §5.5; docs/mockup.html `[data-panel="pull"]`).
 *
 * A global, full-width surface (no chats sidebar, see App.tsx) with: a name
 * field + Pull button, the in-progress layered-progress card (aggregated
 * from PullProgress events), and the searchable model catalog.
 *
 * The one field does three jobs at once — it names what to pull, filters the
 * catalog beneath it, and (inside the desktop shell) probes the registry for
 * what was typed. That last one is what makes a model published after this
 * build shipped still findable: the catalog won't know it, the probe will.
 */
import { useEffect, useState } from "react";
import "./PullView.css";
import { useRemuda } from "../ui/state";
import { PaneHelp, PaneHelpToggle } from "../help/PaneHelp";
import { Capabilities } from "../ui/Capabilities";
import type { Model } from "../api/types";
import { isProbeAvailable, probeModel, type ProbeResult } from "../api/registry";
import { CATALOG, searchCatalog, type CatalogModel } from "./catalog";
import { usePull } from "./usePull";

/** Typing settles before we ask the registry; ~1 request per pause, not per key. */
const PROBE_DEBOUNCE_MS = 350;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Short label for a layer row, e.g. "sha256:8b1a…". */
function shortDigest(digest: string): string {
  const hex = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  return `sha256:${hex.slice(0, 6)}…`;
}

/** An installed tag matches a bare catalog name with or without ":latest". */
function isInstalled(models: Model[], tag: string): boolean {
  return models.some((m) => m.tag === tag || m.tag === `${tag}:latest`);
}

/**
 * Debounced registry probe for whatever is in the field.
 *
 * Returns null when there is nothing to say — empty field, no bridge
 * (browser dev), or a lookup that failed. A failed lookup deliberately
 * renders as nothing rather than "not found": being offline is not evidence
 * that a model doesn't exist (SPEC §5.5).
 */
function useProbe(reference: string): ProbeResult | null {
  const [result, setResult] = useState<ProbeResult | null>(null);

  useEffect(() => {
    const trimmed = reference.trim();
    if (trimmed === "" || !isProbeAvailable()) {
      setResult(null);
      return;
    }
    // Clear immediately: a stale verdict next to newly-typed text reads as a
    // verdict about the new text.
    setResult(null);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void probeModel(trimmed).then((r) => {
        if (!cancelled) setResult(r);
      });
    }, PROBE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [reference]);

  return result;
}

interface CatalogRowProps {
  model: CatalogModel;
  models: Model[];
  disabled: boolean;
  onPull: (tag: string) => void;
}

/**
 * One catalog entry. Size chips are pull buttons in their own right — the
 * library publishes `qwen3` at eight parameter sizes and picking one is the
 * actual decision, so making them clickable saves retyping `qwen3:14b`.
 */
function CatalogRow({ model, models, disabled, onPull }: CatalogRowProps) {
  const latestInstalled = isInstalled(models, model.name);
  return (
    <div className="regrow">
      <div className="regrow-meta">
        <b>{model.name}</b>
        <div>{model.description}</div>
        <Capabilities capabilities={model.capabilities} />
      </div>
      <div className="sizes">
        {model.sizes.map((size) => {
          const tag = `${model.name}:${size}`;
          const installed = isInstalled(models, tag);
          return (
            <button
              type="button"
              className={`btn sm chip${installed ? " installed" : ""}`}
              key={size}
              disabled={disabled || installed}
              onClick={() => onPull(tag)}
              title={installed ? `${tag} is installed` : `Pull ${tag}`}
            >
              {size}
            </button>
          );
        })}
      </div>
      {latestInstalled ? (
        <button type="button" className="btn sm" disabled>
          Installed
        </button>
      ) : (
        <button type="button" className="btn sm" disabled={disabled} onClick={() => onPull(model.name)}>
          Pull
        </button>
      )}
    </div>
  );
}

export function PullView() {
  const { models, status, client, refreshModels } = useRemuda();
  const { pullState, busy, startPull, cancelPull, retryPull } = usePull({ client, refreshModels });
  const [tagInput, setTagInput] = useState("");
  const probe = useProbe(tagInput);
  const results = searchCatalog(CATALOG, tagInput);

  const connected = status.connected;
  // SPEC §9: disable mutating pull actions while disconnected; one pull at a
  // time (usePull) disables new pulls while one is already streaming.
  //
  // The field itself is deliberately NOT in that set. It searches a bundled
  // JSON file, which needs neither a server nor an idle pull — disabling it
  // would strand the user with all 236 rows and no way to filter them for the
  // length of a multi-gigabyte download. Every button that actually mutates
  // anything is disabled independently below.
  const disableStart = !connected || busy;

  function handleSubmit() {
    if (tagInput.trim() === "") return;
    startPull(tagInput);
    setTagInput("");
  }

  const completedBytes = pullState ? pullState.layers.reduce((sum, l) => sum + l.completed, 0) : 0;
  const totalBytes = pullState ? pullState.layers.reduce((sum, l) => sum + l.total, 0) : 0;
  const overallPct = totalBytes > 0 ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : 0;

  return (
    <section className="pullview" aria-label="Pull models">
      <div className="eyebrow">
        Pull a model
        <PaneHelpToggle paneId="pull" label="About getting models" />
      </div>
      <PaneHelp
        paneId="pull"
        title="Get models — download one to run"
        what="Fetches a model from Ollama's library onto this machine. Nothing here talks to anything but Ollama, and the download is Ollama's, not Remuda's."
        why="Remuda runs models, it does not ship any. This is where you get one to tune."
        steps={[
          <>Search the list, or type an exact name like <code>llama3.2:3b</code>.</>,
          <>
            Press <b>Pull</b> and watch the per-layer progress. Big models take a while.
          </>,
          <>
            When it lands, open the model control in the top bar and <b>Load</b> it.
          </>,
        ]}
      />
      <div className="pullbar">
        <input
          className="pull-input"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
          placeholder="Search the library, or name a model to pull"
          spellCheck={false}
          aria-label="Model to pull"
        />
        <button
          type="button"
          className="btn primary"
          onClick={handleSubmit}
          disabled={disableStart || tagInput.trim() === ""}
        >
          Pull
        </button>
      </div>
      <div className="note-strip">
        Filters the list as you type. Pull anything by name — <code>llama3.2</code>,{" "}
        <code>gemma2:9b</code>, or a full URL — even if it isn’t listed below.
      </div>
      {probe !== null && (probe.kind === "found" || probe.kind === "missing") && (
        <div className={`probe${probe.kind === "missing" ? " miss" : ""}`} role="status">
          {probe.kind === "found" ? (
            <>
              <span aria-hidden="true">✓</span> <code>{probe.resolved}</code> ·{" "}
              {formatBytes(probe.totalBytes)} to download
            </>
          ) : (
            <>
              <span aria-hidden="true">✕</span> <code>{probe.resolved}</code> isn’t in the registry
            </>
          )}
        </div>
      )}

      {pullState && (
        <div className="progress" role={pullState.error ? "alert" : "status"}>
          <div className="top">
            <span className={`dot${pullState.error ? " err" : ""}`} aria-hidden="true" />
            <b>{pullState.tag}</b>
            {!pullState.error && <span className="pct">{overallPct}%</span>}
          </div>
          {pullState.error ? (
            <>
              <div className="perror">{pullState.error}</div>
              <button type="button" className="btn sm" onClick={retryPull} disabled={!connected}>
                Retry
              </button>
            </>
          ) : (
            <>
              {pullState.layers.length === 0 ? (
                <div className="layer-status">{pullState.statusLine}</div>
              ) : (
                pullState.layers.map((l) => {
                  const layerPct = l.total > 0 ? Math.min(100, Math.round((l.completed / l.total) * 100)) : 0;
                  const done = l.total > 0 && l.completed >= l.total;
                  return (
                    <div className="layer" key={l.digest}>
                      <span className="lname">{shortDigest(l.digest)}</span>
                      <div className="layer-meter">
                        <i style={{ width: `${layerPct}%` }} />
                      </div>
                      <span className="lpct">{done ? "done" : `${layerPct}%`}</span>
                    </div>
                  );
                })
              )}
              <div className="note-strip pull-foot">
                <span>
                  {formatBytes(completedBytes)} / {formatBytes(totalBytes)}
                </span>
                <div className="spacer" />
                <button type="button" className="btn sm danger" onClick={cancelPull}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="side-label">
        {tagInput.trim() === "" ? "All models" : "Matching"}
        <span className="count">{results.length}</span>
      </div>
      <div className="reg">
        {results.length === 0 ? (
          <div className="noresults">
            Nothing in the bundled catalog matches “{tagInput.trim()}”. If it’s a newer model,
            the name still pulls — the catalog ships with the app and doesn’t know about it yet.
          </div>
        ) : (
          results.map((m) => <CatalogRow key={m.name} model={m} models={models} disabled={disableStart} onPull={startPull} />)
        )}
      </div>
    </section>
  );
}
