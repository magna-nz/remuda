import "../chat/test/localStorage";
import { beforeEach, describe, expect, it } from "vitest";
import type { ArchParams } from "../api/types";
import { predictFit } from "./fit";
import { calibrationFactorFor, recordFitObservation } from "./fitCalibration";

/**
 * The seam between the two modules. `fit.ts` applies the stored factor to the
 * KV term ALONE, so `LoadPane` must record a KV-only ratio. Recording a
 * whole-runner ratio and applying it to KV corrected only the fraction of the
 * total that KV represents, while the readout claimed "Calibrated" — which is
 * exactly the failure neither module's own tests could see.
 */
const LLAMA_8B: ArchParams = {
  architecture: "llama",
  blockCount: 32,
  headCount: 32,
  headCountKv: 8,
  embeddingLength: 4096,
};

const WEIGHTS = 4_700_000_000;
const USABLE = 24_000_000_000;
const CTX = 8192;

beforeEach(() => {
  window.localStorage.clear();
});

describe("fit ↔ calibration round trip", () => {
  it("a recorded observation makes the next prediction reproduce it", () => {
    const raw = predictFit({
      archParams: LLAMA_8B,
      weightsBytes: WEIGHTS,
      usableVramBytes: USABLE,
      ctx: CTX,
      calibrationFactor: 1,
    });
    if (!raw.ok) throw new Error("fixture should predict");

    // The runner really used 20% more KV than predicted.
    const observed = WEIGHTS + raw.kvBytes * 1.2;
    recordFitObservation("llama3.1:8b", raw.kvBytes, observed - raw.weightsBytes);

    const factor = calibrationFactorFor("llama3.1:8b");
    expect(factor).toBeCloseTo(1.2, 6);

    const calibrated = predictFit({
      archParams: LLAMA_8B,
      weightsBytes: WEIGHTS,
      usableVramBytes: USABLE,
      ctx: CTX,
      calibrationFactor: factor ?? 1,
    });
    if (!calibrated.ok) throw new Error("should still predict");

    // The whole point: the calibrated prediction lands on the observation.
    expect(calibrated.totalBytes).toBeCloseTo(observed, 0);
    expect(calibrated.calibrated).toBe(true);
  });

  it("a residency reporting no KV at all is not a usable observation", () => {
    const raw = predictFit({
      archParams: LLAMA_8B,
      weightsBytes: WEIGHTS,
      usableVramBytes: USABLE,
      ctx: CTX,
      calibrationFactor: 1,
    });
    if (!raw.ok) throw new Error("fixture should predict");

    // sizeVram == weights ⇒ nothing left for KV. Not a correction, a bad read.
    recordFitObservation("llama3.1:8b", raw.kvBytes, WEIGHTS - raw.weightsBytes);
    expect(calibrationFactorFor("llama3.1:8b")).toBeNull();
  });

  it("refuses to predict when the server didn't report the model's size", () => {
    const result = predictFit({
      archParams: LLAMA_8B,
      weightsBytes: 0,
      usableVramBytes: USABLE,
      ctx: CTX,
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("totalBytes");
  });
});

describe("a measured reading from a real server", () => {
  /**
   * Ollama 0.32.15, qwen3.8-27b:latest, 52 GB Mac. Predicted 26.28 GB at
   * ctx 32,768 against an actual `size_vram` of 19.70 GB — an implied KV
   * factor of 0.245. A 0.25 floor rejected this, which meant the model whose
   * estimate was furthest out was the one that could never calibrate.
   */
  const QWEN3: ArchParams = {
    architecture: "qwen35",
    blockCount: 65,
    headCount: 24,
    headCountKv: 4,
    embeddingLength: 5120,
    keyLength: 256,
    valueLength: 256,
  };
  const WEIGHTS_Q4 = 17_559_178_407;
  const ACTUAL_VRAM = 19_700_000_000;

  it("accepts the observation and lands the next prediction on it", () => {
    const raw = predictFit({
      archParams: QWEN3,
      weightsBytes: WEIGHTS_Q4,
      usableVramBytes: 38_700_000_000,
      ctx: 32_768,
      calibrationFactor: 1,
    });
    if (!raw.ok) throw new Error("should predict");
    expect(raw.totalBytes / 1e9).toBeCloseTo(26.28, 1);

    recordFitObservation("qwen3.8-27b", raw.kvBytes, ACTUAL_VRAM - raw.weightsBytes);
    const factor = calibrationFactorFor("qwen3.8-27b");
    expect(factor).not.toBeNull();
    expect(factor).toBeCloseTo(0.245, 2);

    const calibrated = predictFit({
      archParams: QWEN3,
      weightsBytes: WEIGHTS_Q4,
      usableVramBytes: 38_700_000_000,
      ctx: 32_768,
      calibrationFactor: factor ?? 1,
    });
    if (!calibrated.ok) throw new Error("should predict");
    expect(calibrated.totalBytes / 1e9).toBeCloseTo(19.7, 1);
  });
});
