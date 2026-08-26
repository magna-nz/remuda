/**
 * The load pane popover (SPEC.md §5.1), in two steps.
 *
 * Step 1 is one row per *model* — not one per installed tag. Step 2 opens a
 * model and asks the two questions separately: which **quantisation** (the
 * weights) and which **Modelfile** (the tuning). A model with no tuned
 * Modelfiles just loads Original (base).
 *
 * The model → quant grouping is derived, not reported by Ollama (see
 * models/grouping.ts), so every row keeps its literal tag on screen —
 * including the exact tag Load will send. A grouping the user disagrees with
 * stays legible instead of mysterious.
 *
 * Loading is still the explicit act — nothing here loads until Load is
 * clicked.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import "./LoadPane.css";
import { useRemuda } from "./state";
import { displayKey, groupByModel, variantCount, type ModelEntry, type QuantOption } from "../models/grouping";

function shortTag(tag: string): string {
  return tag.endsWith(":latest") ? tag.slice(0, -":latest".length) : tag;
}

function glyph(name: string): string {
  const head = name.split(":")[0] ?? name;
  return head.slice(0, 2).toUpperCase();
}

function formatSize(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

type LoadPhase = "idle" | "loading" | "done";

export function LoadPane() {
  const {
    models,
    groups,
    loaded,
    load,
    loadPaneOpen,
    closeLoadPane,
    status,
    openEditorForNew,
    client,
    refreshModels,
    confirmDeleteModel,
    setView,
  } = useRemuda();

  const entries = useMemo(() => groupByModel(groups), [groups]);

  const [step, setStep] = useState<"list" | "detail">("list");
  /** The chosen quant's tag — `base` in the store's LoadedSelection. */
  const [quantTag, setQuantTag] = useState<string | null>(null);
  /** The effective tag that Load sends: a tuning's tag, or the quant's own. */
  const [variantTag, setVariantTag] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [phase, setPhase] = useState<LoadPhase>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  /** A tuning dropped by a quant switch, so the pane can say why. */
  const [droppedVariant, setDroppedVariant] = useState<string | null>(null);
  const seeded = useRef(false);

  // Closing resets everything, so reopening re-derives from whatever is
  // loaded then rather than from a stale prior pick. Opening on a loaded
  // model skips the list and lands on its detail step.
  useEffect(() => {
    if (!loadPaneOpen) {
      seeded.current = false;
      setStep("list");
      setQuantTag(null);
      setVariantTag(null);
      setFilter("");
      setPhase("idle");
      setLoadError(null);
      setDroppedVariant(null);
      return;
    }
    if (seeded.current || entries.length === 0) return;
    seeded.current = true;
    if (loaded) {
      setQuantTag(loaded.base);
      setVariantTag(loaded.variant);
      setStep("detail");
    }
  }, [loadPaneOpen, entries, loaded]);

  if (!loadPaneOpen) return null;

  const entry = entries.find((e) => e.quants.some((q) => q.tag === quantTag)) ?? null;
  const quant = entry?.quants.find((q) => q.tag === quantTag) ?? null;
  const isReload = loaded?.variant === variantTag;

  function drillIn(target: ModelEntry) {
    // Prefer the quant that's already loaded, so reopening a model lands on
    // what's in memory rather than on its first tag.
    const live = loaded ? target.quants.find((q) => q.tag === loaded.base) : undefined;
    const next = live ?? target.quants[0];
    if (next === undefined) return;
    setQuantTag(next.tag);
    setVariantTag(live && loaded ? loaded.variant : next.tag);
    setStep("detail");
    setPhase("idle");
    setLoadError(null);
    setDroppedVariant(null);
  }

  function drillOut() {
    setStep("list");
    setPhase("idle");
    setLoadError(null);
    setDroppedVariant(null);
  }

  function pickQuant(option: QuantOption) {
    if (option.tag === quantTag) return;
    // A Modelfile FROMs one specific tag, so a tuning belongs to a quant and
    // can't carry across. Reset to Original and say so rather than silently
    // loading different weights than the chip implies.
    const carried = variantTag !== null && option.variants.some((v) => v.tag === variantTag);
    const wasTuned = variantTag !== null && variantTag !== quantTag;
    setDroppedVariant(!carried && wasTuned ? variantTag : null);
    setQuantTag(option.tag);
    setVariantTag(carried ? variantTag : option.tag);
    setPhase("idle");
    setLoadError(null);
  }

  function pickVariant(tag: string) {
    setVariantTag(tag);
    setPhase("idle");
    setLoadError(null);
    setDroppedVariant(null);
  }

  async function handleLoad() {
    if (!variantTag) return;
    setPhase("loading");
    setLoadError(null);
    try {
      await load(variantTag);
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

  // SPEC §5.6, §8: Delete confirms when the Settings toggle is on (default
  // on). Deleting the selected quant drops the pane back to the model list —
  // its selection can't keep pointing at a tag that's gone.
  async function handleDelete(tag: string) {
    if (confirmDeleteModel && !window.confirm(`Delete ${tag}? This can't be undone.`)) return;
    setLoadError(null);
    try {
      await client.deleteModel(tag);
      await refreshModels();
      setQuantTag(null);
      setVariantTag(null);
      setStep("list");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  const needle = filter.trim().toLowerCase();
  const visible =
    needle === ""
      ? entries
      : entries.filter((e) =>
          `${e.key} ${e.family} ${e.parameterSize}`.toLowerCase().includes(needle),
        );

  const closeButton = (
    <button type="button" className="iconbtn x" onClick={closeLoadPane} aria-label="Close load pane">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div className="mpane-back" onClick={closeLoadPane} />
      <div className="mpane" role="dialog" aria-label="Load a model">
        <div className="mpane-h">
          {step === "list" || entry === null ? (
            <>
              <b>Load a model</b>
              <span className="sub">
                {entries.length} model{entries.length === 1 ? "" : "s"} · {models.length} tag
                {models.length === 1 ? "" : "s"}
              </span>
              {closeButton}
            </>
          ) : (
            <>
              <button type="button" className="iconbtn" onClick={drillOut} aria-label="Back to model list">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <span className="hstack">
                <span className="htitle">{displayKey(entry.key)}</span>
                <span className="hsub">
                  {[entry.family, entry.parameterSize].filter((s) => s !== "").join(" · ")}
                  {entry.family === "" && entry.parameterSize === "" ? "" : " · "}
                  {entry.quants.length} quant{entry.quants.length === 1 ? "" : "s"}
                </span>
              </span>
              {quant && (
                <button
                  type="button"
                  className="iconbtn danger"
                  title={`Delete ${quant.tag}`}
                  aria-label={`Delete ${quant.tag}`}
                  disabled={!status.connected}
                  onClick={() => void handleDelete(quant.tag)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16z" />
                  </svg>
                </button>
              )}
              {closeButton}
            </>
          )}
        </div>

        <div className="mpane-b">
          {models.length === 0 ? (
            <div className="pempty">
              <p>No models installed yet.</p>
              <button
                type="button"
                className="btn sm primary"
                onClick={() => {
                  closeLoadPane();
                  setView("pull");
                }}
              >
                Pull your first model
              </button>
            </div>
          ) : step === "list" || entry === null ? (
            <div className="pfield">
              <div className="pfilter">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.5-3.5" />
                </svg>
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter models…"
                  aria-label="Filter models"
                />
              </div>
              <div className="pmodels">
                {visible.length === 0 ? (
                  <div className="pnomatch">No model matches “{filter.trim()}”.</div>
                ) : (
                  visible.map((e) => {
                    const tuned = variantCount(e);
                    const live = loaded !== null && e.quants.some((q) => q.tag === loaded.base);
                    return (
                      <button key={e.key + e.quants[0]?.tag} type="button" className={`pmodel${live ? " active" : ""}`} onClick={() => drillIn(e)}>
                        <span className="pg" aria-hidden="true">
                          {glyph(displayKey(e.key))}
                        </span>
                        <span className="pmeta">
                          <span className="pn">{displayKey(e.key)}</span>
                          <span className="ps">
                            {e.quants.length} quant{e.quants.length === 1 ? "" : "s"} ·{" "}
                            {tuned === 0 ? "base only" : `${tuned} Modelfile${tuned === 1 ? "" : "s"}`}
                          </span>
                        </span>
                        {/* Both pills can show at once: "tuned" is a fact
                            about the model, "loaded" about right now. A
                            loaded model shouldn't stop advertising that it
                            has Modelfiles inside. */}
                        <span className="ppills">
                          {tuned > 0 && (
                            <span className="ppill tuned" title={`${tuned} tuned Modelfile${tuned === 1 ? "" : "s"}`}>
                              tuned
                            </span>
                          )}
                          {live && <span className="ppill loaded">loaded</span>}
                        </span>
                        <span className="pchev" aria-hidden="true">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 6l6 6-6 6" />
                          </svg>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="pfoot">Quantisations and tuned Modelfiles live inside each model.</div>
            </div>
          ) : (
            <>
              <div className="pfield">
                <label htmlFor="pane-quants">Quantisation</label>
                <div className="pquants" id="pane-quants">
                  {entry.quants.map((q) => (
                    <button
                      key={q.tag}
                      type="button"
                      className={`pq${q.tag === quantTag ? " active" : ""}`}
                      onClick={() => pickQuant(q)}
                    >
                      <span className="pradio" aria-hidden="true" />
                      <span className="pqmeta">
                        <span className="pqname">{q.quantization === "" ? "Unknown quant" : q.quantization}</span>
                        <span className="pqnote">
                          {[
                            q.variants.length > 0
                              ? `${q.variants.length} Modelfile${q.variants.length === 1 ? "" : "s"}`
                              : "base only",
                            q.isLoaded ? "in memory" : null,
                          ]
                            .filter((s) => s !== null)
                            .join(" · ")}
                        </span>
                        <span className="pqtag" title={q.tag}>
                          {q.tag}
                        </span>
                      </span>
                      <span className="pqsize">{formatSize(q.sizeBytes)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="pfield">
                <label htmlFor="pane-variants">
                  Modelfile{quant && quant.quantization !== "" ? <span className="qual"> for {quant.quantization}</span> : null}
                </label>
                <div className="pvariants" id="pane-variants">
                  {quant && (
                    <button
                      type="button"
                      className={`pv${variantTag === quant.tag ? " active" : ""}`}
                      onClick={() => pickVariant(quant.tag)}
                    >
                      Original (base)
                    </button>
                  )}
                  {quant?.variants.map((v) => (
                    <button
                      key={v.tag}
                      type="button"
                      className={`pv${variantTag === v.tag ? " active" : ""}`}
                      title={v.tag}
                      onClick={() => pickVariant(v.tag)}
                    >
                      {shortTag(v.tag)} · tuned
                    </button>
                  ))}
                  <button
                    type="button"
                    className="pv new"
                    disabled={!quantTag}
                    title={quantTag ? `New Modelfile from ${quantTag}` : "Pick a quantisation first"}
                    onClick={() => {
                      if (!quantTag) return;
                      closeLoadPane();
                      openEditorForNew(quantTag);
                    }}
                  >
                    ＋ New Modelfile
                  </button>
                </div>
                {droppedVariant !== null && (
                  <div className="pnote">
                    {shortTag(droppedVariant)} is built on the other quantisation — reset to Original (base).
                  </div>
                )}
              </div>

              <div className="ploadwrap">
                <button
                  type="button"
                  className="btn primary wide"
                  onClick={() => void handleLoad()}
                  disabled={phase === "loading" || !variantTag || !status.connected}
                  title={status.connected ? undefined : "Ollama isn't running"}
                >
                  {phase === "loading" ? "Loading…" : isReload ? "Reload model" : "Load model"}
                </button>
                {variantTag !== null && (
                  <div className="psummary">
                    loads <code>{variantTag}</code>
                  </div>
                )}
                {loadError !== null && (
                  <div className="perror" role="alert">
                    {loadError}
                  </div>
                )}
                {phase !== "idle" && (
                  <div className="pprogress">
                    <div className="meter">
                      <i
                        className={phase === "loading" ? "indeterminate" : undefined}
                        style={{ width: phase === "done" ? "100%" : "55%" }}
                      />
                    </div>
                    <div className="pptext">
                      {phase === "done"
                        ? `✓ ${variantTag} loaded and ready`
                        : `Loading ${variantTag} — pulling weights into memory…`}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
