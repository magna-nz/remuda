/**
 * The load pane popover (SPEC.md §5.1): every installed model, the
 * Modelfile picker (Original + tuned variants of the selected base), and
 * the Load button. Loading is the explicit act — nothing here loads a
 * model until Load is clicked.
 */
import { useEffect, useState } from "react";
import "./LoadPane.css";
import { useRemuda } from "./state";
import type { Model } from "../api/types";

function shortTag(tag: string): string {
  return tag.endsWith(":latest") ? tag.slice(0, -":latest".length) : tag;
}

function glyph(tag: string): string {
  const name = tag.split(":")[0] ?? tag;
  return name.slice(0, 2).toUpperCase();
}

function formatSize(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

type LoadPhase = "idle" | "loading" | "done";

export function LoadPane() {
  const { models, groups, loaded, load, loadPaneOpen, closeLoadPane, status, openEditorForNew } =
    useRemuda();
  const [selectedBase, setSelectedBase] = useState<string | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<string | null>(null);
  const [phase, setPhase] = useState<LoadPhase>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);

  // Reset the selection when the pane closes, so reopening it re-derives
  // from whatever is loaded then (rather than a stale prior pick).
  useEffect(() => {
    if (loadPaneOpen) return;
    setSelectedBase(null);
    setSelectedVariant(null);
    setPhase("idle");
    setLoadError(null);
  }, [loadPaneOpen]);

  // Seed the default selection (the loaded model, or the first base) once
  // the pane is open and the model list has arrived — but never stomp a
  // selection the user already made by clicking a row.
  useEffect(() => {
    if (!loadPaneOpen) return;
    setSelectedBase((prev) => prev ?? loaded?.base ?? groups[0]?.base.tag ?? null);
    setSelectedVariant((prev) => prev ?? loaded?.variant ?? loaded?.base ?? groups[0]?.base.tag ?? null);
  }, [loadPaneOpen, groups, loaded]);

  if (!loadPaneOpen) return null;

  function pickModel(model: Model) {
    const base = model.isVariant && model.base ? model.base : model.tag;
    const variant = model.isVariant ? model.tag : base;
    setSelectedBase(base);
    setSelectedVariant(variant);
    setPhase("idle");
    setLoadError(null);
  }

  function pickVariant(tag: string) {
    setSelectedVariant(tag);
    setPhase("idle");
    setLoadError(null);
  }

  async function handleLoad() {
    if (!selectedVariant) return;
    setPhase("loading");
    setLoadError(null);
    try {
      await load(selectedVariant);
      setPhase("done");
      window.setTimeout(() => {
        closeLoadPane();
      }, 500);
    } catch (err) {
      // SPEC §9: surface the server's error text verbatim, don't reset quietly.
      setPhase("idle");
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  const currentGroup = groups.find((g) => g.base.tag === selectedBase) ?? null;
  const isReload = loaded?.variant === selectedVariant;

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div className="mpane-back" onClick={closeLoadPane} />
      <div className="mpane" role="dialog" aria-label="Load a model">
        <div className="mpane-h">
          <b>Load a model</b>
          <span className="sub">{models.length} installed</span>
          <button type="button" className="iconbtn x" onClick={closeLoadPane} aria-label="Close load pane">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="mpane-b">
          <div className="pfield">
            <label htmlFor="pane-models">Model</label>
            <div className="pmodels" id="pane-models">
              {models.map((m) => {
                const active = m.isVariant ? m.tag === selectedVariant : m.tag === selectedBase;
                return (
                  <button
                    key={m.tag}
                    type="button"
                    className={`pmodel${active ? " active" : ""}`}
                    onClick={() => pickModel(m)}
                  >
                    <span className="pg" aria-hidden="true">
                      {glyph(m.tag)}
                    </span>
                    <span>
                      <span className="pn">{m.tag}</span>
                      <span className="ps">
                        {m.isVariant ? `custom · from ${m.base}` : `${formatSize(m.sizeBytes)} · ${m.quantization}`}
                      </span>
                    </span>
                    {m.isVariant && <span className="ptune">tuned</span>}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="pfield">
            <label htmlFor="pane-variants">Modelfile</label>
            <div className="pvariants" id="pane-variants">
              {currentGroup && (
                <button
                  type="button"
                  className={`pv${selectedVariant === currentGroup.base.tag ? " active" : ""}`}
                  onClick={() => pickVariant(currentGroup.base.tag)}
                >
                  Original (base)
                </button>
              )}
              {currentGroup?.variants.map((v) => (
                <button
                  key={v.tag}
                  type="button"
                  className={`pv${selectedVariant === v.tag ? " active" : ""}`}
                  onClick={() => pickVariant(v.tag)}
                >
                  {shortTag(v.tag)} · tuned
                </button>
              ))}
              <button
                type="button"
                className="pv new"
                disabled={!selectedBase}
                title={selectedBase ? `New Modelfile from ${selectedBase}` : "Pick a base model first"}
                onClick={() => {
                  if (!selectedBase) return;
                  closeLoadPane();
                  openEditorForNew(selectedBase);
                }}
              >
                ＋ New Modelfile
              </button>
            </div>
          </div>
          <div className="ploadwrap">
            <button
              type="button"
              className="btn primary wide"
              onClick={() => void handleLoad()}
              disabled={phase === "loading" || !selectedVariant || !status.connected}
              title={status.connected ? undefined : "Ollama isn't running"}
            >
              {phase === "loading" ? "Loading…" : isReload ? "Reload model" : "Load model"}
            </button>
            {loadError !== null && (
              <div className="perror" role="alert">
                {loadError}
              </div>
            )}
            {phase !== "idle" && (
              <div className="pprogress">
                <div className="meter">
                  <i className={phase === "loading" ? "indeterminate" : undefined} style={{ width: phase === "done" ? "100%" : "55%" }} />
                </div>
                <div className="pptext">
                  {phase === "done" ? `✓ ${selectedVariant} loaded and ready` : `Loading ${selectedVariant} — pulling weights into memory…`}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
