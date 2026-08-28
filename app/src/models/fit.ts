/**
 * Fit predictor arithmetic (SPEC-tuning.md T4). Pure — no React, no I/O.
 *
 * Given an architecture's shape (from POST /api/show's `model_info`), the
 * installed weights size (from /api/tags) and how much VRAM is usable, this
 * estimates the KV cache a context length would cost and whether the whole
 * runner fits.
 *
 *   key_dim  = attention.key_length,   else embeddingLength / headCount
 *   value_dim = attention.value_length, else the same
 *   kv_bytes = blockCount × headCountKv × (key_dim + value_dim) × ctx
 *              × bytesPerElement
 *   total   ≈ weightsBytes + kv_bytes + overhead
 *
 * `bytesPerElement` assumes an f16 KV cache — there is no endpoint that
 * reports `OLLAMA_KV_CACHE_TYPE`, so a user running a quantised cache (e.g.
 * q8_0, half the bytes) makes every figure here an overestimate until a real
 * load calibrates it (see fitCalibration.ts).
 *
 * **No prediction is a first-class result.** `archParams === null` (the
 * server's `model_info` didn't carry enough) or `usableVramBytes === null`
 * (no host-memory reading) both return `{ ok: false }` — never a fabricated
 * number. A wrong prediction here costs the user a five-minute model load.
 */
import type { ArchParams } from "../api/types";

/** f16 KV cache assumption — the one Ollama defaults to. Halved by
 * `OLLAMA_KV_CACHE_TYPE=q8_0`, which no endpoint reports (see module doc). */
export const BYTES_PER_KV_ELEMENT = 2;

/**
 * No endpoint reports Ollama's own runtime buffer overhead (KV cache
 * bookkeeping, compute buffers, etc.), so this is zero rather than a guessed
 * constant. Any real-world gap between this prediction and what actually
 * loaded is exactly what `fitCalibration.ts` folds back in after the first
 * load — a wrong constant here would double-count what calibration already
 * corrects for.
 */
export const RUNTIME_OVERHEAD_BYTES = 0;

/**
 * Ollama's own default ceiling on Apple Silicon — roughly 75% of unified
 * memory, reserving the rest for the OS and other processes. This is
 * Ollama's heuristic, not a measured limit Remuda can read back, so it is
 * named and documented here rather than buried in a call site.
 */
export const APPLE_SILICON_VRAM_FRACTION = 0.75;

/** Usable VRAM from total unified memory, per Ollama's Apple Silicon default. */
export function usableVramFromHostMemory(memTotalBytes: number): number {
  return Math.max(0, memTotalBytes * APPLE_SILICON_VRAM_FRACTION);
}

export interface FitInputs {
  archParams: ArchParams | null;
  /** Installed weights size, from /api/tags — a known fact, not an estimate. */
  weightsBytes: number;
  /** null when there is no host-memory reading (SPEC-tuning T4, no Tauri bridge). */
  usableVramBytes: number | null;
  ctx: number;
  /** The model's trained max context, if known — clamps the fit ceiling. */
  trainedCtx?: number | null;
  /**
   * A **KV-only** correction from the model's last real load:
   * `(actualVram - weightsBytes) / predictedKvBytes` (fitCalibration.ts).
   *
   * KV-only because it is applied to the KV term alone below — the weights
   * figure is already exact. Recording a whole-runner `actual / predicted`
   * ratio here and applying it to KV corrects only the fraction of the total
   * that KV represents, while the readout claims "Calibrated". That was a
   * real shipped bug; the two sites have to agree.
   *
   * Defaults to 1 (uncalibrated / pure estimate).
   */
  calibrationFactor?: number;
}

export interface FitPrediction {
  ok: true;
  /** ≈ weightsBytes + kvBytes + RUNTIME_OVERHEAD_BYTES, at `ctx`. */
  totalBytes: number;
  weightsBytes: number;
  /** The KV cache portion at `ctx`, calibrated if a factor was supplied. */
  kvBytes: number;
  usableVramBytes: number;
  fits: boolean;
  /** 0 when it fits; otherwise totalBytes - usableVramBytes. */
  spillBytes: number;
  /** Largest ctx that fits in usableVramBytes, clamped to trainedCtx. Never negative. */
  ctxCeiling: number;
  /** True when a real calibration factor (not the uncalibrated default) was applied. */
  calibrated: boolean;
}

export interface NoFitPrediction {
  ok: false;
  reason: string;
}

export type FitResult = FitPrediction | NoFitPrediction;

/** head_dim, and the KV bytes cost per token of context — the per-ctx slope. */
function kvBytesPerCtxToken(archParams: ArchParams): number | null {
  const { blockCount, headCount, headCountKv, embeddingLength } = archParams;
  if (blockCount <= 0 || headCount <= 0 || headCountKv <= 0 || embeddingLength <= 0) {
    return null;
  }
  // K and V are sized independently. Prefer the dimensions the server states
  // outright; derive only when it doesn't. Qwen3 is the case that makes this
  // matter — key_length 256 against embedding_length 5120 / head_count 24,
  // whose derived 213.33 is both fractional and 17% low.
  const derived = embeddingLength / headCount;
  const keyDim = archParams.keyLength ?? derived;
  const valueDim = archParams.valueLength ?? derived;
  return blockCount * headCountKv * (keyDim + valueDim) * BYTES_PER_KV_ELEMENT;
}

/**
 * The largest context length that fits in `usableVramBytes`, solved directly
 * (not looped) from the linear relationship between ctx and KV bytes.
 * Clamped to `trainedCtx` when given, and never negative.
 */
export function fitCeiling(
  archParams: ArchParams,
  weightsBytes: number,
  usableVramBytes: number,
  options: { trainedCtx?: number | null; calibrationFactor?: number } = {},
): number {
  const slope = kvBytesPerCtxToken(archParams);
  if (slope === null || slope <= 0) return 0;
  const factor = options.calibrationFactor ?? 1;
  const budget = usableVramBytes - weightsBytes - RUNTIME_OVERHEAD_BYTES;
  const raw = budget <= 0 ? 0 : Math.floor(budget / (slope * factor));
  const clamped = options.trainedCtx != null ? Math.min(raw, options.trainedCtx) : raw;
  return Math.max(0, clamped);
}

/** Predict the fit of one context length. Never fabricates a number when the
 * inputs don't support one — see the module doc. */
export function predictFit(inputs: FitInputs): FitResult {
  const { archParams, weightsBytes, usableVramBytes, ctx, trainedCtx = null } = inputs;

  if (archParams === null) {
    return {
      ok: false,
      reason:
        "the server's model_info didn't report enough to predict (block_count, head_count, head_count_kv, embedding_length)",
    };
  }
  if (usableVramBytes === null) {
    return { ok: false, reason: "usable VRAM is unknown on this machine" };
  }
  // /api/tags omits `size` on some servers, and client.ts floors that to 0.
  // Predicting from a zero weights figure would render "fits entirely on GPU"
  // for a model whose weights alone might not — wrong by the size of the model.
  if (!(weightsBytes > 0)) {
    return { ok: false, reason: "the server didn't report this model's size on disk" };
  }

  const slope = kvBytesPerCtxToken(archParams);
  if (slope === null) {
    return { ok: false, reason: "model_info reported an invalid architecture shape" };
  }

  const factor = inputs.calibrationFactor ?? 1;
  const kvBytes = slope * Math.max(0, ctx) * factor;
  const totalBytes = weightsBytes + RUNTIME_OVERHEAD_BYTES + kvBytes;
  const fits = totalBytes <= usableVramBytes;

  return {
    ok: true,
    totalBytes,
    weightsBytes,
    kvBytes,
    usableVramBytes,
    fits,
    spillBytes: fits ? 0 : totalBytes - usableVramBytes,
    ctxCeiling: fitCeiling(archParams, weightsBytes, usableVramBytes, { trainedCtx, calibrationFactor: factor }),
    calibrated: inputs.calibrationFactor !== undefined && inputs.calibrationFactor !== 1,
  };
}
