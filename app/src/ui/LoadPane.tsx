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
import { Capabilities } from "./Capabilities";
import { displayKey, groupByModel, variantCount, type ModelEntry, type QuantOption } from "../models/grouping";
import type { RunningModel } from "../api/types";

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

/**
 * The Expires cell (SPEC §5.1, mockup-proposals.html §01): a live countdown
 * to `expiresAt`, floored at zero rather than going negative — the poll
 * clears `running` shortly after it actually lapses. `null` is an infinite
 * `keep_alive`, not a broken timestamp.
 */
function formatCountdown(expiresAt: string | null, nowMs: number): string {
  if (expiresAt === null) return "never";
  const target = Date.parse(expiresAt);
  if (Number.isNaN(target)) return "—";
  const remainingSec = Math.max(0, Math.floor((target - nowMs) / 1000));
  const m = Math.floor(remainingSec / 60);
  const s = remainingSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

type LoadPhase = "idle" | "loading" | "ejecting" | "done";

export function LoadPane() {
  const {
    models,
    groups,
    loaded,
    running,
    load,
    loadPaneOpen,
    closeLoadPane,
    status,
    openEditorForNew,
    client,
    refreshModels,
    confirmDeleteModel,
    setView,
    unload,
    streamingSessionId,
  } = useRemuda();

  const entries = useMemo(() => groupByModel(groups), [groups]);
  /**
   * What's actually in memory (SPEC §5.1's runtime strip), independent of
   * the pane's current selection — the same rule Eject already follows: it
   * names whatever is loaded, not whatever the pane happens to be showing.
   */
  const runningEntry: RunningModel | null = useMemo(
    () => (loaded ? (running.find((r) => r.tag === loaded.variant) ?? null) : null),
    [running, loaded],
  );

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
  /** Clock for the Expires countdown; ticks once a second while something's loaded. */
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (runningEntry === null || runningEntry.expiresAt === null) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [runningEntry]);

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

  // Runtime strip (SPEC §5.1, mockup-proposals.html §01). sizeBytes === 0 is
  // "the server said nothing useful" — no percentage, no bar, no split.
  const gpuPct =
    runningEntry && runningEntry.sizeBytes > 0
      ? Math.round((runningEntry.sizeVramBytes / runningEntry.sizeBytes) * 100)
      : null;
  const spilling =
    runningEntry !== null && runningEntry.sizeBytes > 0 && runningEntry.sizeVramBytes < runningEntry.sizeBytes;
  const vramBytes = runningEntry?.sizeVramBytes ?? 0;
  const ramBytes = runningEntry ? Math.max(0, runningEntry.sizeBytes - runningEntry.sizeVramBytes) : 0;
  const gpuBarPct = runningEntry && runningEntry.sizeBytes > 0 ? (vramBytes / runningEntry.sizeBytes) * 100 : 0;
  const cpuBarPct = spilling ? 100 - gpuBarPct : 0;
  // The model's trained max, for "used / max" — looked up in the flat model
  // list rather than QuantOption, which doesn't carry contextLength.
  const runningMaxContext = runningEntry
    ? (models.find((m) => m.tag === runningEntry.tag)?.contextLength ?? null)
    : null;
  // Eject's size (SPEC §5.1c) is the same lookup the strip uses — both are
  // about what's in memory, not the pane's current selection. A reported 0
  // is "the server didn't say", exactly as it is for the GPU split above, so
  // it falls back to the plain label rather than promising to free 0 MB.
  const ejectSizeLabel =
    runningEntry && runningEntry.sizeBytes > 0 ? formatSize(runningEntry.sizeBytes) : null;

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

  /**
   * Hand the loaded model's memory back (SPEC §7, `keep_alive: 0`).
   *
   * Unlike Load, this always acts on what's *in memory* — not on the pane's
   * current selection — so the button names the tag it frees. The pane stays
   * open: the quant's "in memory" note and the Load/Reload label flip on the
   * refresh, which is the confirmation that it worked.
   */
  async function handleEject() {
    if (!loaded) return;
    setPhase("ejecting");
    setLoadError(null);
    try {
      await unload();
      setPhase("idle");
    } catch (err) {
      // SPEC §9: the server's text, verbatim.
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
                    // Capabilities are per-installed-tag (POST /api/show), not
                    // per derived model — the first quant stands in for the
                    // whole row, same as the glyph and the "N quants" count.
                    const firstTag = e.quants[0]?.tag;
                    const capabilities = firstTag ? (models.find((m) => m.tag === firstTag)?.capabilities ?? []) : [];
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
                          <Capabilities capabilities={capabilities} />
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
              {/* Runtime strip (SPEC §5.1, mockup-proposals.html §01): what's
                  actually in memory. Independent of the entry on screen —
                  same rule as Eject (it names whatever is loaded, not
                  whatever the pane is showing). */}
              {runningEntry !== null && (
                <div className="pfield">
                  <label>In memory now</label>
                  <div className="rt">
                    <div className="rt-top">
                      <span className="rt-tag">{runningEntry.tag}</span>
                      {gpuPct !== null && (
                        <span className={`rt-badge rt-inline${spilling ? " spill" : ""}`}>{gpuPct}% GPU</span>
                      )}
                    </div>
                    {runningEntry.sizeBytes > 0 && (
                      <>
                        <div className="rt-bar">
                          <i className="gpu" style={{ width: `${gpuBarPct}%` }} />
                          {spilling && <i className="cpu" style={{ width: `${cpuBarPct}%` }} />}
                        </div>
                        <div className="rt-legend">
                          <span>
                            <i className="rt-dot gpu" aria-hidden="true" />
                            VRAM {formatSize(vramBytes)}
                          </span>
                          {spilling && (
                            <span>
                              <i className="rt-dot cpu" aria-hidden="true" />
                              RAM {formatSize(ramBytes)}
                            </span>
                          )}
                        </div>
                      </>
                    )}
                    <div className="rt-grid">
                      <div className="rt-cell">
                        <div className="k">Context</div>
                        <div className="v">
                          {runningEntry.contextLength === null ? "—" : runningEntry.contextLength.toLocaleString("en-US")}
                          {runningMaxContext !== null && runningMaxContext !== runningEntry.contextLength && (
                            <small> / {runningMaxContext.toLocaleString("en-US")}</small>
                          )}
                        </div>
                      </div>
                      <div className="rt-cell">
                        <div className="k">Expires</div>
                        <div className="v">{formatCountdown(runningEntry.expiresAt, nowMs)}</div>
                      </div>
                      <div className="rt-cell">
                        <div className="k">Total size</div>
                        <div className="v">
                          {runningEntry.sizeBytes > 0 ? formatSize(runningEntry.sizeBytes) : "—"}
                        </div>
                      </div>
                    </div>
                    {spilling && (
                      <div className="rt-warn">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                        </svg>
                        <div>
                          <b>{formatSize(ramBytes)} is running on the CPU.</b> Expect a large drop in tok/s. Try a
                          smaller quant, or a lower <code>num_ctx</code>.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

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
                <div className="pactions">
                  <button
                    type="button"
                    className="btn primary wide"
                    onClick={() => void handleLoad()}
                    disabled={phase === "loading" || phase === "ejecting" || !variantTag || !status.connected}
                    title={status.connected ? undefined : "Ollama isn't running"}
                  >
                    {phase === "loading" ? "Loading…" : isReload ? "Reload model" : "Load model"}
                  </button>
                  {/* Ejecting is about what's in memory, so this shows
                      whenever anything is loaded — including while another
                      model's detail is on screen — and names the tag it
                      frees rather than the one Load would send. */}
                  {loaded !== null && (
                    <button
                      type="button"
                      className="btn eject"
                      onClick={() => void handleEject()}
                      disabled={phase !== "idle" || !status.connected || streamingSessionId !== null}
                      aria-label={`Eject ${loaded.variant}`}
                      title={
                        !status.connected
                          ? "Ollama isn't running"
                          : streamingSessionId !== null
                            ? "Wait for the reply to finish"
                            : `Unload ${loaded.variant} from memory`
                      }
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 4l7 9H5z" />
                        <path d="M5 18h14" />
                      </svg>
                      {phase === "ejecting" ? "Ejecting…" : `Eject${ejectSizeLabel ? ` ${ejectSizeLabel}` : ""}`}
                    </button>
                  )}
                </div>
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
                {/* Load's meter only. Ejecting is a single fast call with
                    nothing to measure — its button label carries the state. */}
                {(phase === "loading" || phase === "done") && (
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
