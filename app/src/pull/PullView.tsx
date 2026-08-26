/**
 * Pull view (SPEC.md §5.5; docs/mockup.html `[data-panel="pull"]`).
 *
 * A global, full-width surface (no chats sidebar, see App.tsx) with: a name
 * field + Pull button, the in-progress layered-progress card (aggregated
 * from PullProgress events), and a curated Popular list.
 */
import { useState } from "react";
import "./PullView.css";
import { useRemuda } from "../ui/state";
import type { Model } from "../api/types";
import { POPULAR_MODELS } from "./popular";
import { usePull } from "./usePull";

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

/** An installed tag matches a bare popular tag with or without ":latest". */
function isInstalled(models: Model[], tag: string): boolean {
  return models.some((m) => m.tag === tag || m.tag === `${tag}:latest`);
}

export function PullView() {
  const { models, status, client, refreshModels } = useRemuda();
  const { pullState, busy, startPull, cancelPull, retryPull } = usePull({ client, refreshModels });
  const [tagInput, setTagInput] = useState("");

  const connected = status.connected;
  // SPEC §9: disable mutating pull actions while disconnected; one pull at a
  // time (usePull) disables new pulls while one is already streaming.
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
      <div className="eyebrow">Pull a model</div>
      <div className="pullbar">
        <input
          className="pull-input"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
          placeholder="e.g. llama3.2, gemma2:9b"
          spellCheck={false}
          aria-label="Model to pull"
          disabled={disableStart}
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
        Name a model from the registry, e.g. <code>llama3.2</code>, <code>gemma2:9b</code>, or a full URL.
      </div>

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

      <div className="side-label">Popular</div>
      <div className="reg">
        {POPULAR_MODELS.map((p) => {
          const installed = isInstalled(models, p.tag);
          return (
            <div className="regrow" key={p.tag}>
              <div className="rt">
                <b>{p.tag}</b>
                <div>{p.blurb}</div>
              </div>
              <span className="sz">{formatBytes(p.approxSizeBytes)}</span>
              {installed ? (
                <button type="button" className="btn sm" disabled>
                  Installed
                </button>
              ) : (
                <button type="button" className="btn sm" disabled={disableStart} onClick={() => startPull(p.tag)}>
                  Pull
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
