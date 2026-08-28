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
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import "./LoadPane.css";
import { useRemuda } from "./state";
import { Capabilities } from "./Capabilities";
import { displayKey, groupByModel, variantCount, type ModelEntry, type QuantOption } from "../models/grouping";
import type { ArchParams, OllamaClient, RunningModel } from "../api/types";
import { hostStats, type HostStats } from "../api/host";
import { predictFit, usableVramFromHostMemory } from "../models/fit";
import { calibrationFactorFor, recordFitObservation } from "../models/fitCalibration";

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

type LoadPhase = "idle" | "loading" | "done";

/** The VRAM/RAM split for one resident model, or null when the server said nothing. */
interface Split {
  gpuPct: number;
  spilling: boolean;
  vramBytes: number;
  ramBytes: number;
}

function splitOf(entry: RunningModel): Split | null {
  if (entry.sizeBytes <= 0) return null;
  const vramBytes = entry.sizeVramBytes;
  const ramBytes = Math.max(0, entry.sizeBytes - vramBytes);
  return {
    gpuPct: Math.round((vramBytes / entry.sizeBytes) * 100),
    spilling: vramBytes < entry.sizeBytes,
    vramBytes,
    ramBytes,
  };
}

/**
 * One resident model in the memory tray.
 *
 * Everything here is about memory, not about the model on disk: what it
 * costs, whether it fits on the GPU, when it expires, and the two things you
 * can do about that. It deliberately does *not* offer Load — that belongs to
 * the model's own detail step, one level down.
 */
function MemorySlot({
  entry,
  maxContext,
  nowMs,
  active,
  busy,
  disabled,
  onEject,
  onKeep,
}: {
  entry: RunningModel;
  maxContext: number | null;
  nowMs: number;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  onEject: () => void;
  onKeep: (kept: boolean) => void;
}) {
  const split = splitOf(entry);
  const kept = entry.expiresAt === null;
  const spilling = split?.spilling ?? false;
  return (
    <div className={`slot${spilling ? " spill" : ""}${active ? " active" : ""}`}>
      <div className="slot-top">
        <span className="slot-tag" title={entry.tag}>
          {shortTag(entry.tag)}
        </span>
        {active && <span className="inuse">this chat</span>}
        <span className="slot-grow" />
        {split !== null && (
          <span className={`rt-inline${spilling ? " spill" : ""}`}>{split.gpuPct}% on GPU</span>
        )}
      </div>
      {split !== null && (
        <div className="rt-bar">
          <i className="gpu" style={{ width: `${split.gpuPct}%` }} />
          {spilling && <i className="cpu" style={{ width: `${100 - split.gpuPct}%` }} />}
        </div>
      )}
      <div className="slot-sub">
        {entry.sizeBytes > 0 && <span>{formatSize(entry.sizeBytes)}</span>}
        {entry.contextLength !== null && (
          <>
            <span className="sep" aria-hidden="true">·</span>
            {/* The trained max only earns its place when it differs from what
                the model was actually loaded with — otherwise it's the same
                number printed twice. */}
            <span>
              ctx {entry.contextLength.toLocaleString("en-US")}
              {maxContext !== null && maxContext !== entry.contextLength && (
                <small> / {maxContext.toLocaleString("en-US")}</small>
              )}
            </span>
          </>
        )}
        <span className="sep" aria-hidden="true">·</span>
        {/* An expiry that never arrives is a different fact from a countdown,
            so it reads as a state rather than as "never" in a time slot. */}
        <span className={kept ? "keptnote" : undefined}>
          {kept ? "kept" : `expires ${formatCountdown(entry.expiresAt, nowMs)}`}
        </span>
        {spilling && split !== null && (
          <>
            <span className="sep" aria-hidden="true">·</span>
            <span className="warnish">{formatSize(split.ramBytes)} on CPU</span>
          </>
        )}
      </div>
      {/* Actions get their own row rather than trailing the facts: how much
          metadata a model reports varies, and rows that change shape with it
          are hard to scan down. */}
      <div className="slot-acts">
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy || disabled}
            title={kept ? `Let ${entry.tag} expire again` : `Keep ${entry.tag} in memory — no expiry`}
            onClick={() => onKeep(!kept)}
          >
            {kept ? "Let expire" : "Keep"}
          </button>
          <button
            type="button"
            className="btn sm eject"
            disabled={busy || disabled}
            aria-label={`Eject ${entry.tag}`}
            title={disabled ? "Wait for the reply to finish" : `Unload ${entry.tag} from memory`}
            onClick={onEject}
          >
            {busy ? "…" : "Eject"}
          </button>
      </div>
      {spilling && split !== null && (
        <div className="rt-warn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
          <div>
            <b>{formatSize(split.ramBytes)} is running on the CPU.</b> Expect a large drop in tok/s. Eject
            another model, try a smaller quant, or lower <code>num_ctx</code>.
          </div>
        </div>
      )}
    </div>
  );
}

/** "21000" → "21K" — the tick labels, which have no room for full numbers. */
function formatCtxShort(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`;
}

/** A default context to open the slider on: modest, never above the trained max. */
const DEFAULT_CTX = 4096;
/** Slider ceiling when the server never reported the model's trained context. */
const FALLBACK_MAX_CTX = 32768;
const CTX_SLIDER_MIN = 512;
const CTX_SLIDER_STEP = 256;

/**
 * The Context field (SPEC-tuning T4): a slider that predicts, before Load is
 * even clicked, whether a context length fits the model in VRAM.
 *
 * Its own component — not inlined into LoadPane's already-large detail step —
 * so it can own `key={variantTag}` at the call site: switching quant or
 * Modelfile is a new model as far as the slider is concerned, and remounting
 * is a cleaner reset than threading another tag-keyed effect through.
 *
 * Three states, matching docs/mockup-tuning.html#t4 exactly:
 *  - no prediction (archParams is null, or hostStats() is null): no fit
 *    track, no tick, no fabricated number — a sentence saying what's missing.
 *  - fits: green track, "Fits entirely on GPU".
 *  - spills: amber past the ceiling, "Spills N to system RAM".
 */
function FitPanel({
  client,
  tag,
  weightsBytes,
  trainedCtx,
  resident,
  onCtxChosen,
}: {
  client: OllamaClient;
  tag: string;
  weightsBytes: number;
  /** The model's trained max context (POST /api/show's contextLength), or null. */
  trainedCtx: number | null;
  /** This tag's live /api/ps entry, if resident — for calibrating after a real load. */
  resident: RunningModel | null;
  /**
   * Fires only once the user has actually moved the slider. Until then the
   * load sends no `num_ctx` at all, so a Modelfile's own `PARAMETER num_ctx`
   * keeps winning — silently overriding it with our default would be the
   * predictor changing the thing it claims only to predict.
   */
  onCtxChosen: (ctx: number) => void;
}) {
  const [archParams, setArchParams] = useState<ArchParams | null>(null);
  const [hostMem, setHostMem] = useState<HostStats | null>(null);
  const [ctx, setCtx] = useState(() => Math.min(DEFAULT_CTX, trainedCtx ?? DEFAULT_CTX));
  /** Bumped after recordFitObservation writes, so the "Calibrated" copy
   * reflects it immediately rather than waiting for an unrelated re-render. */
  const [calibrationVersion, bumpCalibration] = useReducer((n: number) => n + 1, 0);
  /** Guards against re-recording the same reading twice for one residency. */
  const recordedKey = useRef<string | null>(null);

  // POST /api/show, for this one tag's model_info — archParams is
  // all-or-nothing (api/client.ts), so a partial reading never reaches here.
  useEffect(() => {
    let cancelled = false;
    client
      .show(tag)
      .then((detail) => {
        if (!cancelled) setArchParams(detail.archParams);
      })
      .catch(() => {
        if (!cancelled) setArchParams(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, tag]);

  // Resolves to null with no Tauri bridge — every vitest run, every plain
  // browser tab — and the no-prediction state below renders correctly for it.
  useEffect(() => {
    let cancelled = false;
    hostStats()
      .then((stats) => {
        if (!cancelled) setHostMem(stats);
      })
      .catch(() => {
        if (!cancelled) setHostMem(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const usableVramBytes = hostMem !== null ? usableVramFromHostMemory(hostMem.memTotalBytes) : null;
  const calibrationFactor = calibrationFactorFor(tag);
  const calibrated = calibrationFactor !== null;
  const fit = predictFit({
    archParams,
    weightsBytes,
    usableVramBytes,
    ctx,
    trainedCtx,
    calibrationFactor: calibrationFactor ?? 1,
  });

  // The estimate self-corrects (SPEC-tuning T4): once this tag is actually
  // resident and fully on GPU, compare what a *raw* (uncalibrated) prediction
  // at its real running context would have said against what /api/ps
  // actually reports, and store the ratio. A spilled or partial load isn't a
  // clean calibration point, so it's excluded here rather than in
  // fitCalibration.ts, which has no way to know residency on its own.
  useEffect(() => {
    if (resident === null || resident.sizeBytes <= 0 || resident.contextLength === null) return;
    if (archParams === null || usableVramBytes === null) return;
    const spilling = resident.sizeVramBytes < resident.sizeBytes;
    if (spilling) return;
    const key = `${tag}:${resident.sizeVramBytes}:${resident.contextLength}`;
    if (recordedKey.current === key) return;
    const raw = predictFit({
      archParams,
      weightsBytes,
      usableVramBytes,
      ctx: resident.contextLength,
      trainedCtx,
      calibrationFactor: 1,
    });
    if (raw.ok) {
      // The factor is applied to the KV term alone (fit.ts), because the
      // weights figure is already exact — so the observation has to be a
      // KV-only ratio too. Recording actual/predictedTotal here and applying
      // it to KV corrected only the ~18% of the total that KV represents,
      // while the readout claimed the number was "calibrated".
      recordFitObservation(
        tag,
        raw.kvBytes,
        resident.sizeVramBytes - raw.weightsBytes,
      );
      recordedKey.current = key;
      bumpCalibration();
    }
  }, [resident, archParams, usableVramBytes, weightsBytes, trainedCtx, tag]);

  // Embedding models report trained contexts as low as 256, which would put
  // the ceiling under the slider's floor: max < min yields a NaN track width
  // and lets one drag pin a num_ctx *above* the model's trained maximum.
  const sliderMax = Math.max(CTX_SLIDER_MIN, trainedCtx ?? FALLBACK_MAX_CTX);
  const pct = (n: number) =>
    sliderMax <= CTX_SLIDER_MIN
      ? 0
      : Math.min(100, Math.max(0, ((n - CTX_SLIDER_MIN) / (sliderMax - CTX_SLIDER_MIN)) * 100));
  const fitPct = fit.ok ? pct(Math.min(fit.ctxCeiling, sliderMax)) : 0;
  const showsCeiling = fit.ok && fit.ctxCeiling < sliderMax;

  const fitreadClass = !fit.ok ? "none" : fit.fits ? "ok" : "spill";
  const r1 = !fit.ok
    ? "No prediction available"
    : fit.fits
      ? "✓ Fits entirely on GPU"
      : `⚠ Spills ${formatSize(fit.spillBytes)} to system RAM`;
  const r2 = fit.ok
    ? `≈ ${formatSize(fit.totalBytes)} of ${formatSize(fit.usableVramBytes)} usable · ${formatSize(fit.weightsBytes)} weights + ${formatSize(fit.kvBytes)} KV`
    : archParams === null
      ? "model_info didn't report enough to predict"
      : "usable VRAM is unknown on this machine";
  const r3 = fit.ok
    ? calibrated
      ? "Calibrated from your last load of this model · f16 KV cache"
      : "Estimated · assumes an f16 KV cache · load once to calibrate"
    : archParams === null
      ? "The server didn't say enough to predict. Load it and Remuda will measure."
      : "Available inside the Remuda desktop app — load it and Remuda will measure from /api/ps.";

  // calibrationVersion has no direct reader: re-reading calibrationFactorFor
  // above on every render is what actually picks up a fresh write, and this
  // dependency only exists to force that render after bumpCalibration().
  void calibrationVersion;

  return (
    <div className="pfield">
      <div className="ctxhead">
        <label htmlFor="pane-ctx">Context</label>
        <span className="cv">{ctx.toLocaleString("en-US")}</span>
      </div>
      <div className="track">
        {fit.ok && (
          <>
            <div className="fit" style={{ width: `${fitPct}%` }} />
            {showsCeiling && <div className="over" style={{ left: `${fitPct}%`, right: 0 }} />}
            {showsCeiling && (
              <div className="tick" style={{ left: `${fitPct}%` }}>
                <span>fits to {formatCtxShort(fit.ctxCeiling)}</span>
              </div>
            )}
          </>
        )}
        {/* SPEC-tuning T4: no prediction means no tick at all, not even the
            trained-context one — a tick implies a track worth reading. */}
        {fit.ok && trainedCtx !== null && (
          <div className="tick trained" style={{ left: `${pct(trainedCtx)}%` }}>
            <span>{formatCtxShort(trainedCtx)} trained</span>
          </div>
        )}
        <input
          type="range"
          id="pane-ctx"
          className="ctxrange"
          min={CTX_SLIDER_MIN}
          max={sliderMax}
          step={CTX_SLIDER_STEP}
          value={ctx}
          onChange={(e) => {
            const next = Number(e.target.value);
            setCtx(next);
            onCtxChosen(next);
          }}
          aria-label="Context length"
        />
      </div>
      <div className={`fitread ${fitreadClass}`}>
        <span className="r1">{r1}</span>
        <span className="r2">{r2}</span>
        <span className="r3">{r3}</span>
      </div>
    </div>
  );
}

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
    unloadAll,
    setKept,
    streamingSessionId,
    sessions,
    activeSessionId,
  } = useRemuda();

  const entries = useMemo(() => groupByModel(groups), [groups]);
  /**
   * What's actually in memory (SPEC §5.1's runtime strip) — every resident
   * model, not the pane's current selection. This is machine state, so it
   * lives at the pane's root rather than inside any one model's detail.
   *
   * A resident tag with no /api/ps entry is dropped rather than rendered
   * blank: the two reads are separate requests and can disagree for one
   * tick, and a row with no numbers in it says less than no row.
   */
  const slots = useMemo(
    () => loaded.flatMap((sel) => running.filter((r) => r.tag === sel.variant)),
    [loaded, running],
  );
  const totalResidentBytes = slots.reduce((sum, r) => sum + r.sizeBytes, 0);

  const [step, setStep] = useState<"list" | "detail">("list");
  /** The chosen quant's tag — `base` in the store's LoadedSelection. */
  const [quantTag, setQuantTag] = useState<string | null>(null);
  /** The effective tag that Load sends: a tuning's tag, or the quant's own. */
  const [variantTag, setVariantTag] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [phase, setPhase] = useState<LoadPhase>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * The context the user deliberately chose on the fit slider, or null when
   * they never touched it — in which case the load sends no `num_ctx` and
   * Ollama/the Modelfile decides, as before (SPEC-tuning T4).
   */
  const [chosenCtx, setChosenCtx] = useState<number | null>(null);

  // Picking a different model drops any context the user chose for the last
  // one — carrying it across would apply one model's ceiling to another's.
  useEffect(() => {
    setChosenCtx(null);
  }, [variantTag]);
  /** A tuning dropped by a quant switch, so the pane can say why. */
  const [droppedVariant, setDroppedVariant] = useState<string | null>(null);
  /** The tray row with a call in flight, or "*" while Eject all runs. */
  const [busyTag, setBusyTag] = useState<string | null>(null);
  /** Clock for the Expires countdown; ticks once a second while anything can expire. */
  const [nowMs, setNowMs] = useState(() => Date.now());

  const anyExpiring = slots.some((r) => r.expiresAt !== null);
  useEffect(() => {
    if (!anyExpiring) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [anyExpiring]);

  // Closing resets everything, so reopening re-derives from whatever is
  // loaded then rather than from a stale prior pick. The pane always opens on
  // the list — the tray at its top already answers "what's loaded?", and a
  // resident model's detail step is one click away rather than the screen the
  // button drops you on whether or not you wanted it.
  useEffect(() => {
    if (loadPaneOpen) return;
    setStep("list");
    setQuantTag(null);
    setVariantTag(null);
    setFilter("");
    setPhase("idle");
    setLoadError(null);
    setDroppedVariant(null);
    setBusyTag(null);
  }, [loadPaneOpen]);

  if (!loadPaneOpen) return null;

  const entry = entries.find((e) => e.quants.some((q) => q.tag === quantTag)) ?? null;
  const quant = entry?.quants.find((q) => q.tag === quantTag) ?? null;
  // "Reload" only when the exact tag Load would send is already resident.
  const isReload = variantTag !== null && loaded.some((l) => l.variant === variantTag);
  /** This step's own model, if it happens to be in memory — one line, not a card. */
  const detailEntry = variantTag !== null ? (running.find((r) => r.tag === variantTag) ?? null) : null;
  const detailSplit = detailEntry ? splitOf(detailEntry) : null;
  const activeSessionModel = sessions.find((s) => s.id === activeSessionId)?.model;
  // Ejecting mid-stream would pull the weights out from under the reply.
  const ejectBlocked = !status.connected || streamingSessionId !== null;

  function drillIn(target: ModelEntry) {
    // Prefer a quant of *this* model that's already resident, so reopening it
    // lands on what's in memory rather than on its first tag. With several
    // models loaded only this one's residency is relevant here.
    const residentHere = loaded.find((l) => target.quants.some((q) => q.tag === l.base));
    const live = residentHere ? target.quants.find((q) => q.tag === residentHere.base) : undefined;
    const next = live ?? target.quants[0];
    if (next === undefined) return;
    setQuantTag(next.tag);
    setVariantTag(live && residentHere ? residentHere.variant : next.tag);
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
      await load(variantTag, chosenCtx ?? undefined);
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
   * Hand one model's memory back (SPEC §7, `keep_alive: 0`).
   *
   * Named by row, so it always frees the tag the user pointed at rather than
   * a pane-wide notion of "the" model. The pane stays open: the row leaving
   * the tray is the confirmation that it worked.
   */
  async function handleEject(tag: string) {
    setBusyTag(tag);
    setLoadError(null);
    try {
      await unload(tag);
    } catch (err) {
      // SPEC §9: the server's text, verbatim.
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTag(null);
    }
  }

  async function handleEjectAll() {
    setBusyTag("*");
    setLoadError(null);
    try {
      await unloadAll();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTag(null);
    }
  }

  /** Pin a row against its keep_alive expiry, or hand it back to the clock. */
  async function handleKeep(tag: string, kept: boolean) {
    setBusyTag(tag);
    setLoadError(null);
    try {
      await setKept(tag, kept);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTag(null);
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
            <>
              {/* What's in memory now, at the pane's root — machine state,
                  so it sits above the installed list rather than inside any
                  one model's detail (SPEC §5.1, docs/mockup-memory.html §02). */}
              {slots.length > 0 && (
                <div className="pfield">
                  <label>
                    In memory
                    {totalResidentBytes > 0 && <span className="rhs">{formatSize(totalResidentBytes)}</span>}
                  </label>
                  <div className="tray">
                    {slots.map((rt) => (
                      <MemorySlot
                        key={rt.tag}
                        entry={rt}
                        maxContext={models.find((m) => m.tag === rt.tag)?.contextLength ?? null}
                        nowMs={nowMs}
                        active={rt.tag === activeSessionModel}
                        busy={busyTag === rt.tag || busyTag === "*"}
                        disabled={ejectBlocked}
                        onEject={() => void handleEject(rt.tag)}
                        onKeep={(kept) => void handleKeep(rt.tag, kept)}
                      />
                    ))}
                    {slots.length > 1 && (
                      <div className="trayfoot">
                        <span>
                          {slots.length} models in memory
                        </span>
                        <button
                          type="button"
                          className="btn sm ghost"
                          disabled={busyTag !== null || ejectBlocked}
                          onClick={() => void handleEjectAll()}
                        >
                          {busyTag === "*" ? "Ejecting…" : "Eject all"}
                        </button>
                      </div>
                    )}
                  </div>
                  {loadError !== null && (
                    <div className="perror" role="alert">
                      {loadError}
                    </div>
                  )}
                </div>
              )}

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
                    const live = loaded.some((l) => e.quants.some((q) => q.tag === l.base));
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
            </>
          ) : (
            <>
              {/* This step is about a model on disk — its quants, its
                  Modelfiles, and the button that loads it. Its only claim on
                  runtime is whether *this* model is resident, which is one
                  line; the full readout lives in the tray at the pane's root
                  (docs/mockup-memory.html §03). */}
              {detailEntry !== null && (
                // The whole line is the control — a separate "view in memory"
                // button next to a label reading "In memory" said it twice,
                // and wrapped as soon as the numbers got long.
                <button
                  type="button"
                  className="minirt"
                  onClick={drillOut}
                  aria-label="View in memory"
                  title="See everything that's in memory"
                >
                  <span className="lead">In memory</span>
                  <span>
                    {[
                      detailEntry.sizeBytes > 0 ? formatSize(detailEntry.sizeBytes) : null,
                      detailSplit !== null ? `${detailSplit.gpuPct}% on GPU` : null,
                      detailEntry.expiresAt === null ? "kept" : formatCountdown(detailEntry.expiresAt, nowMs),
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </span>
                  <span className="slot-grow" />
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
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

              {variantTag !== null && (
                <FitPanel
                  key={variantTag}
                  client={client}
                  tag={variantTag}
                  weightsBytes={models.find((m) => m.tag === variantTag)?.sizeBytes ?? quant?.sizeBytes ?? 0}
                  trainedCtx={models.find((m) => m.tag === variantTag)?.contextLength ?? null}
                  resident={detailEntry}
                  onCtxChosen={setChosenCtx}
                />
              )}

              <div className="ploadwrap">
                <div className="pactions">
                  {/* Load only. Ejecting moved to the memory tray, where it
                      is per-row: a single Eject here could only ever mean one
                      of several resident models, and picking for the user is
                      exactly the guess that made this pane wrong. */}
                  <button
                    type="button"
                    className="btn primary wide"
                    onClick={() => void handleLoad()}
                    disabled={phase === "loading" || !variantTag || !status.connected}
                    title={status.connected ? undefined : "Ollama isn't running"}
                  >
                    {phase === "loading" ? "Loading…" : isReload ? "Reload model" : "Load model"}
                  </button>
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
                      {/* Ollama reports no progress for a load — the call
                          simply blocks until the weights are resident. So the
                          bar sweeps rather than fills: a bar parked at some
                          fraction reads as "this far along", which would be a
                          number we don't have. */}
                      <i className={phase === "loading" ? "indeterminate" : undefined} />
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
