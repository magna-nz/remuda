import { describe, expect, it } from "vitest";
import {
  APPLE_SILICON_VRAM_FRACTION,
  fitCeiling,
  predictFit,
  usableVramFromHostMemory,
  type FitPrediction,
} from "./fit";
import type { ArchParams } from "../api/types";

/**
 * A llama3.1:8b-shaped architecture: block_count 32, head_count 32,
 * head_count_kv 8, embedding_length 4096 — so head_dim = 4096 / 32 = 128 and
 * the KV cost per context token is
 *   2 × 32 × 8 × 128 × 2 (f16) = 131,072 bytes/token,
 * which divides evenly into the fixture numbers below.
 */
const LLAMA_8B: ArchParams = {
  architecture: "llama",
  blockCount: 32,
  headCount: 32,
  headCountKv: 8,
  embeddingLength: 4096,
};
const WEIGHTS_BYTES = 4_900_000_000;

function ok(result: ReturnType<typeof predictFit>): FitPrediction {
  if (!result.ok) throw new Error(`expected a prediction, got: ${result.reason}`);
  return result;
}

describe("predictFit", () => {
  it("matches the hand-computed llama-shaped fixture at ctx 16,384", () => {
    const result = ok(
      predictFit({
        archParams: LLAMA_8B,
        weightsBytes: WEIGHTS_BYTES,
        usableVramBytes: 10_900_000_000,
        ctx: 16_384,
      }),
    );
    // kv = 131,072 × 16,384 = 2,147,483,648
    expect(result.kvBytes).toBe(2_147_483_648);
    expect(result.weightsBytes).toBe(4_900_000_000);
    expect(result.totalBytes).toBe(7_047_483_648);
    expect(result.fits).toBe(true);
    expect(result.spillBytes).toBe(0);
    expect(result.calibrated).toBe(false);
  });

  it("reports a spill, and the exact overflow, past the fit ceiling", () => {
    const result = ok(
      predictFit({
        archParams: LLAMA_8B,
        weightsBytes: WEIGHTS_BYTES,
        usableVramBytes: 10_900_000_000,
        ctx: 65_536,
      }),
    );
    // kv = 131,072 × 65,536 = 8,589,934,592
    expect(result.kvBytes).toBe(8_589_934_592);
    expect(result.totalBytes).toBe(13_489_934_592);
    expect(result.fits).toBe(false);
    expect(result.spillBytes).toBe(2_589_934_592);
  });

  it("doubling ctx doubles the KV portion but leaves weights untouched", () => {
    const usableVramBytes = 50_000_000_000; // large enough that neither ctx spills
    const at16k = ok(
      predictFit({ archParams: LLAMA_8B, weightsBytes: WEIGHTS_BYTES, usableVramBytes, ctx: 16_384 }),
    );
    const at32k = ok(
      predictFit({ archParams: LLAMA_8B, weightsBytes: WEIGHTS_BYTES, usableVramBytes, ctx: 32_768 }),
    );
    expect(at32k.kvBytes).toBe(at16k.kvBytes * 2);
    expect(at32k.weightsBytes).toBe(at16k.weightsBytes);
    expect(at32k.totalBytes).toBe(at16k.totalBytes + at16k.kvBytes);
  });

  it("scales only the KV portion by the calibration factor", () => {
    const result = ok(
      predictFit({
        archParams: LLAMA_8B,
        weightsBytes: WEIGHTS_BYTES,
        usableVramBytes: 10_900_000_000,
        ctx: 16_384,
        calibrationFactor: 0.5,
      }),
    );
    expect(result.kvBytes).toBe(1_073_741_824); // half of 2,147,483,648
    expect(result.weightsBytes).toBe(4_900_000_000); // untouched
    expect(result.totalBytes).toBe(5_973_741_824);
    expect(result.calibrated).toBe(true);
  });

  it("returns the cannot-predict result, and no number, when archParams is null", () => {
    const result = predictFit({
      archParams: null,
      weightsBytes: WEIGHTS_BYTES,
      usableVramBytes: 10_900_000_000,
      ctx: 16_384,
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("totalBytes");
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("returns the cannot-predict result when usable VRAM is unknown", () => {
    const result = predictFit({
      archParams: LLAMA_8B,
      weightsBytes: WEIGHTS_BYTES,
      usableVramBytes: null,
      ctx: 16_384,
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("totalBytes");
  });

  it("treats a non-positive architecture field as unpredictable rather than dividing by zero", () => {
    const broken: ArchParams = { ...LLAMA_8B, headCount: 0 };
    const result = predictFit({
      archParams: broken,
      weightsBytes: WEIGHTS_BYTES,
      usableVramBytes: 10_900_000_000,
      ctx: 16_384,
    });
    expect(result.ok).toBe(false);
  });
});

describe("fitCeiling", () => {
  it("solves for the exact largest ctx that fits, without looping", () => {
    // budget = 7,521,440,000 - 4,900,000,000 = 2,621,440,000
    // 2,621,440,000 / 131,072 = 20,000 exactly
    const ceiling = fitCeiling(LLAMA_8B, WEIGHTS_BYTES, 7_521_440_000);
    expect(ceiling).toBe(20_000);
  });

  it("clamps the ceiling at the model's trained context length", () => {
    const ceiling = fitCeiling(LLAMA_8B, WEIGHTS_BYTES, 7_521_440_000, { trainedCtx: 8192 });
    expect(ceiling).toBe(8192);
  });

  it("never goes negative when weights alone exceed usable VRAM", () => {
    const ceiling = fitCeiling(LLAMA_8B, WEIGHTS_BYTES, 1_000_000_000);
    expect(ceiling).toBe(0);
  });

  it("folds the calibration factor into the ceiling", () => {
    // Same budget as above, but a 0.5 factor means each token of ctx now
    // "costs" half as much KV, so double the ctx fits.
    const ceiling = fitCeiling(LLAMA_8B, WEIGHTS_BYTES, 7_521_440_000, { calibrationFactor: 0.5 });
    expect(ceiling).toBe(40_000);
  });
});

describe("usableVramFromHostMemory", () => {
  it("applies the named Apple Silicon fraction", () => {
    expect(APPLE_SILICON_VRAM_FRACTION).toBe(0.75);
    expect(usableVramFromHostMemory(32_000_000_000, true)).toBe(24_000_000_000);
  });

  it("never goes negative", () => {
    expect(usableVramFromHostMemory(0, true)).toBe(0);
  });

  // The Linux case. Host memory says nothing about a discrete card's VRAM,
  // so there is no honest number to return — and a wrong one here costs the
  // user a five-minute model load.
  it("returns null when memory is not unified, however much RAM there is", () => {
    expect(usableVramFromHostMemory(64_000_000_000, false)).toBeNull();
    expect(usableVramFromHostMemory(0, false)).toBeNull();
  });

  it("feeds the no-prediction path rather than a fabricated fit", () => {
    const usableVramBytes = usableVramFromHostMemory(64_000_000_000, false);
    const fit = predictFit({
      archParams: LLAMA_8B,
      weightsBytes: WEIGHTS_BYTES,
      usableVramBytes,
      ctx: 8192,
    });
    expect(fit.ok).toBe(false);
  });
});

/* ── explicit key/value dims (a real Qwen3 off a live server) ──────────── */

describe("architectures that declare key_length / value_length", () => {
  // Verbatim from POST /api/show on Ollama 0.32.15, qwen3.8-27b:latest.
  // Deriving head_dim here gives 5120/24 = 213.33 — fractional, and wrong.
  const QWEN3: ArchParams = {
    architecture: "qwen35",
    blockCount: 65,
    headCount: 24,
    headCountKv: 4,
    embeddingLength: 5120,
    keyLength: 256,
    valueLength: 256,
  };

  it("uses the declared dims rather than deriving them", () => {
    const result = predictFit({
      archParams: QWEN3,
      weightsBytes: 17_559_178_407,
      usableVramBytes: 48_000_000_000,
      ctx: 8192,
    });
    if (!result.ok) throw new Error("should predict");

    // 65 blocks x 4 kv-heads x (256 + 256) x 2 bytes = 266,240 B/token.
    expect(result.kvBytes).toBe(266_240 * 8192);
  });

  it("differs materially from the derived figure — this is worth the branch", () => {
    const declared = predictFit({
      archParams: QWEN3,
      weightsBytes: 17_559_178_407,
      usableVramBytes: 48_000_000_000,
      ctx: 8192,
    });
    const derivedOnly = predictFit({
      archParams: { ...QWEN3, keyLength: undefined, valueLength: undefined },
      weightsBytes: 17_559_178_407,
      usableVramBytes: 48_000_000_000,
      ctx: 8192,
    });
    if (!declared.ok || !derivedOnly.ok) throw new Error("should predict");
    // Deriving under-counts the KV cache by ~17% on this real model.
    expect(derivedOnly.kvBytes / declared.kvBytes).toBeCloseTo(0.833, 2);
  });

  it("still derives when the server declares neither", () => {
    const llama: ArchParams = {
      architecture: "llama",
      blockCount: 32,
      headCount: 32,
      headCountKv: 8,
      embeddingLength: 4096,
    };
    const result = predictFit({
      archParams: llama,
      weightsBytes: 4_700_000_000,
      usableVramBytes: 24_000_000_000,
      ctx: 8192,
    });
    if (!result.ok) throw new Error("should predict");
    // head_dim 128 -> 2 x 32 x 8 x 128 x 2 = 131,072 B/token, unchanged.
    expect(result.kvBytes).toBe(131_072 * 8192);
  });
});
