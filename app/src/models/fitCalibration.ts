/**
 * Fit predictor calibration (SPEC-tuning.md T4). Self-contained: its own
 * storage key, its own module — deliberately not folded into
 * `ui/state.tsx` or `chat/sessions.ts`, which a concurrent wave owns.
 *
 * After a real load, /api/ps reports the actual resident VRAM. Storing
 * `actual / predicted` per model tag and folding it into the next
 * prediction's KV portion (fit.ts's `calibrationFactor`) turns the second
 * touch of a model from modelled into measured — see fit.ts's module doc for
 * why only the KV portion is scaled.
 *
 * Persistence idiom copied from `chat/sessions.ts`: an exported storage key,
 * pure load/save, per-field coercion so one bad entry doesn't sink the rest,
 * and a try/catch that degrades to a safe default rather than throwing.
 */

/**
 * Do not bump this. A new key would drop every user's existing calibration —
 * cheap to lose (the pane just falls back to "Estimated" again), but there is
 * no reason to force it.
 */
export const FIT_CALIBRATION_STORAGE_KEY = "remuda.fit-calibration.v1";

/** actual / predicted VRAM, per model tag. */
export type FitCalibration = Record<string, number>;

/**
 * Sane band for a calibration ratio. A reading outside this is almost
 * certainly a bad sample (a spilled load, a stale /api/ps race, a unit
 * mismatch) rather than a real correction.
 *
 * The floor is 0.1, and that is not paranoia — it is measured. Ollama 0.32.15
 * loading qwen3.8-27b at ctx 32,768 on a 52 GB Mac reported 19.7 GB against a
 * predicted 26.3 GB, an implied KV factor of **0.245**. An earlier 0.25 floor
 * rejected that reading as an outlier, so the one model most in need of
 * calibration would never have got any. The f16 assumption in fit.ts is an
 * upper bound on modern Ollama, which quantises the KV cache and does not
 * necessarily allocate the whole window up front.
 *
 * The band is wide because the
 * stored factor corrects the **KV term only** — the weights figure is already
 * exact — so a modest whole-runner error shows up here as a large KV
 * multiplier. A band tuned for a whole-runner ratio would silently reject
 * valid observations, and applying it would poison
 * every later prediction for that tag — so it's rejected at the write site
 * (see recordFitObservation), not just clamped for display.
 */
export const MIN_CALIBRATION_RATIO = 0.1;
export const MAX_CALIBRATION_RATIO = 4.0;

function isSaneRatio(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_CALIBRATION_RATIO && value <= MAX_CALIBRATION_RATIO;
}

function coerceCalibration(value: unknown): FitCalibration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const result: FitCalibration = {};
  for (const [tag, ratio] of Object.entries(raw)) {
    if (typeof tag !== "string" || tag === "") continue;
    if (typeof ratio !== "number" || !isSaneRatio(ratio)) continue;
    result[tag] = ratio;
  }
  return result;
}

/** Load persisted calibration; corrupt or missing data starts empty. */
export function loadFitCalibration(): FitCalibration {
  try {
    const raw = window.localStorage.getItem(FIT_CALIBRATION_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return coerceCalibration(parsed);
  } catch {
    return {};
  }
}

export function saveFitCalibration(calibration: FitCalibration): void {
  try {
    window.localStorage.setItem(FIT_CALIBRATION_STORAGE_KEY, JSON.stringify(calibration));
  } catch {
    // Quota/private-mode failures: calibration simply won't survive a restart.
  }
}

/**
 * Record one observation from a real load: the fit predicted `predictedVramBytes`
 * and /api/ps actually reported `actualVramBytes`.
 *
 * Guarded on both ends:
 *  - a zero or negative reading on either side is ignored (nothing to divide,
 *    or a clearly bad sample) rather than producing Infinity/NaN/a negative
 *    ratio;
 *  - a ratio outside [MIN_CALIBRATION_RATIO, MAX_CALIBRATION_RATIO] is
 *    ignored — a wild reading must not poison every later prediction.
 *
 * Callers are expected to call this only for a model that loaded fully
 * (fully on GPU, not spilled) — a partial/spilled load is not a clean
 * calibration point and this module has no way to detect that on its own.
 */
export function recordFitObservation(
  tag: string,
  predictedVramBytes: number,
  actualVramBytes: number,
): void {
  if (predictedVramBytes <= 0 || actualVramBytes <= 0) return;
  const ratio = actualVramBytes / predictedVramBytes;
  if (!isSaneRatio(ratio)) return;
  const calibration = loadFitCalibration();
  calibration[tag] = ratio;
  saveFitCalibration(calibration);
}

/** This tag's calibration factor, or null when it has never loaded cleanly. */
export function calibrationFactorFor(tag: string): number | null {
  const calibration = loadFitCalibration();
  const ratio = calibration[tag];
  return typeof ratio === "number" && isSaneRatio(ratio) ? ratio : null;
}
