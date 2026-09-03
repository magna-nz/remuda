/**
 * The Run-time memory check (docs/mockup-new-menu.html §05).
 *
 * The load-bearing case is the *negative* one: lanes run sequentially, so two
 * big lanes must never be summed against each other. A test that only checked
 * collisions would pass on an implementation that invented that bug.
 */
import { describe, expect, it } from "vitest";
import { observedCtx, preflight } from "./preflight";
import { UNCONFIGURED_LANE } from "./benchmarks";
import type { Lane } from "./types";
import type { ArchParams, Model, RunningModel } from "../api/types";
import { makeModel } from "../ui/test/FakeClient";

const GB = 1_000_000_000;

/** A shape whose KV slope is small enough that weights dominate the figure. */
const ARCH: ArchParams = {
  architecture: "llama",
  blockCount: 32,
  headCount: 32,
  headCountKv: 8,
  embeddingLength: 4096,
};

function model(tag: string, sizeGb: number): Model {
  return makeModel({ tag, sizeBytes: sizeGb * GB, archParams: ARCH, contextLength: 8192 });
}

function resident(tag: string, sizeGb: number, pinned = false): RunningModel {
  return {
    tag,
    sizeBytes: sizeGb * GB,
    sizeVramBytes: sizeGb * GB,
    contextLength: 8192,
    expiresAt: pinned ? null : "2026-08-29T12:00:00Z",
  };
}

function lane(id: string, model: string): Lane {
  return { id, model, modelfile: null };
}

const CTX = 4096;

describe("observedCtx", () => {
  it("prefers what a resident runner actually reports over the fallback", () => {
    // Ollama sizes the context to memory rather than to a fixed default, so
    // the fallback is a guess and /api/ps is a measurement.
    expect(observedCtx([resident("y:7b", 5)], 4096)).toBe(8192);
  });

  it("takes the largest observed, because under-estimating KV costs a load", () => {
    const small = { ...resident("a:7b", 5), contextLength: 4096 };
    const big = { ...resident("b:7b", 5), contextLength: 26624 };
    expect(observedCtx([small, big], 4096)).toBe(26624);
  });

  it("falls back only when no runner is resident to observe", () => {
    expect(observedCtx([], 4096)).toBe(4096);
    // A server that omits context_length is not an observation either.
    expect(observedCtx([{ ...resident("a:7b", 5), contextLength: null }], 4096)).toBe(4096);
  });
});

describe("preflight", () => {
  it("never sums two lanes against each other — they run one at a time", () => {
    // Each lane is 20 GB against 48 GB usable: fine alone, over the line if
    // something summed them. run.ts rule 2 means nothing ever does.
    const result = preflight({
      lanes: [lane("l1", "a:q8"), lane("l2", "b:q8")],
      models: [model("a:q8", 20), model("b:q8", 20)],
      running: [],
      usableVramBytes: 48 * GB,
      fallbackCtx: CTX,
    });
    expect(result.lanes.map((v) => v.kind)).toEqual(["fits", "fits"]);
    expect(result.needsUnload).toBe(false);
    expect(result.blockers).toEqual([]);
  });

  it("reuses a lane whose model is already resident, and never counts it twice", () => {
    const result = preflight({
      lanes: [lane("l1", "y:7b")],
      models: [model("y:7b", 5)],
      running: [resident("y:7b", 5)],
      usableVramBytes: 8 * GB,
      fallbackCtx: CTX,
    });
    expect(result.lanes[0]).toMatchObject({ kind: "reuse", model: "y:7b" });
    expect(result.needsUnload).toBe(false);
  });

  it("flags the collision when a resident model leaves too little for a lane", () => {
    const result = preflight({
      lanes: [lane("l1", "big:27b")],
      models: [model("big:27b", 24)],
      running: [resident("y:7b", 5)],
      usableVramBytes: 27 * GB,
      fallbackCtx: CTX,
    });
    const verdict = result.lanes[0];
    expect(verdict?.kind).toBe("collides");
    expect(result.needsUnload).toBe(true);
    expect(result.blockers).toEqual([{ tag: "y:7b", sizeBytes: 5 * GB, pinned: false }]);
  });

  it("reports a pinned blocker as pinned — Ollama will not evict it to make room", () => {
    const result = preflight({
      lanes: [lane("l1", "big:27b")],
      models: [model("big:27b", 24)],
      running: [resident("y:7b", 5, true)],
      usableVramBytes: 27 * GB,
      fallbackCtx: CTX,
    });
    expect(result.blockers[0]).toMatchObject({ tag: "y:7b", pinned: true });
  });

  it("calls a lane too-big rather than colliding when unloading would not save it", () => {
    const result = preflight({
      lanes: [lane("l1", "huge:70b")],
      models: [model("huge:70b", 40)],
      running: [resident("y:7b", 5)],
      usableVramBytes: 27 * GB,
      fallbackCtx: CTX,
    });
    expect(result.lanes[0]).toMatchObject({ kind: "too-big" });
    expect(result.hasTooBig).toBe(true);
    // The resident model is not to blame, so it is not offered as the fix.
    expect(result.needsUnload).toBe(false);
    expect(result.blockers).toEqual([]);
  });

  it("returns unknown, not a pass, when usable VRAM cannot be read", () => {
    const result = preflight({
      lanes: [lane("l1", "a:7b")],
      models: [model("a:7b", 5)],
      running: [resident("y:7b", 5)],
      usableVramBytes: null,
      fallbackCtx: CTX,
    });
    expect(result.lanes[0]).toMatchObject({ kind: "unknown" });
    expect(result.allUnknown).toBe(true);
    expect(result.needsUnload).toBe(false);
  });

  it("returns unknown when the server reported no architecture for the model", () => {
    const result = preflight({
      lanes: [lane("l1", "a:7b")],
      models: [makeModel({ tag: "a:7b", sizeBytes: 5 * GB, archParams: null })],
      running: [],
      usableVramBytes: 27 * GB,
      fallbackCtx: CTX,
    });
    expect(result.lanes[0]).toMatchObject({ kind: "unknown" });
  });

  it("matches /api/ps against lanes normalised, not literally", () => {
    // /api/ps and /api/tags disagree about the implicit `:latest` and about
    // case (models/tags.ts). A literal compare misses the resident model AND
    // leaves it in `others`, counting the same weights twice — which showed
    // the user an unload prompt for the very model the lane wanted to reuse.
    const result = preflight({
      lanes: [lane("l1", "qwen:7b-instruct")],
      models: [model("qwen:7b-instruct", 20)],
      running: [resident("Qwen:7B-Instruct:latest", 20)],
      usableVramBytes: 27 * GB,
      fallbackCtx: CTX,
    });
    expect(result.lanes[0]).toMatchObject({ kind: "reuse" });
    expect(result.needsUnload).toBe(false);
    expect(result.blockers).toEqual([]);
  });

  it("skips an unconfigured lane rather than reporting it as a memory problem", () => {
    const result = preflight({
      lanes: [lane("l1", UNCONFIGURED_LANE), lane("l2", "a:7b")],
      models: [model("a:7b", 5)],
      running: [],
      usableVramBytes: 27 * GB,
      fallbackCtx: CTX,
    });
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]).toMatchObject({ kind: "fits", model: "a:7b" });
  });

  it("sums every resident model a lane does not reuse", () => {
    // Two chats' models held at once: 5 + 5 against a 14 GB lane and 24 usable.
    const result = preflight({
      lanes: [lane("l1", "c:14b")],
      models: [model("c:14b", 14)],
      running: [resident("y:7b", 5), resident("z:7b", 5)],
      usableVramBytes: 24 * GB,
      fallbackCtx: CTX,
    });
    expect(result.lanes[0]).toMatchObject({ kind: "collides" });
    expect(result.blockers.map((b) => b.tag)).toEqual(["y:7b", "z:7b"]);
  });

  it("uses the observed context for KV, not the fallback", () => {
    // The bug this pins: assuming 4096 while Ollama had actually started the
    // resident runner at 26,624 under-estimated KV by ~6 GB on a 27B, which
    // is the whole margin the check exists to protect. Same machine, same
    // lane, same resident model — only the observed context differs.
    // Sized so the KV term alone decides it: 31 GB of weights + 5 GB resident
    // is 36.5 GB at ctx 4096 and 39.5 GB at ctx 26,624, either side of 39.
    // The trained window has to be wide enough to hold the observed context,
    // or the clamp below caps it before the KV term can matter.
    const lane27b = makeModel({
      tag: "q:27b",
      sizeBytes: 31 * GB,
      archParams: ARCH,
      contextLength: 32768,
    });
    const inputs = (ctxOfResident: number) => ({
      lanes: [lane("l1", "q:27b")],
      models: [lane27b],
      running: [{ ...resident("y:7b", 5), contextLength: ctxOfResident }],
      usableVramBytes: 39 * GB,
      fallbackCtx: 4096,
    });
    // At a small context the lane fits beside the resident model...
    expect(preflight(inputs(4096)).lanes[0]?.kind).toBe("fits");
    // ...and at the context this server actually uses, it does not.
    expect(preflight(inputs(26624)).lanes[0]?.kind).toBe("collides");
  });

  it("never predicts more context than the model was trained for", () => {
    const small = makeModel({
      tag: "tiny:1b",
      sizeBytes: 1 * GB,
      archParams: ARCH,
      contextLength: 2048,
    });
    const result = preflight({
      lanes: [lane("l1", "tiny:1b")],
      models: [small],
      running: [{ ...resident("y:7b", 5), contextLength: 131072 }],
      usableVramBytes: 39 * GB,
      fallbackCtx: 4096,
    });
    // Clamped to 2048, so a huge observed context cannot invent a huge KV
    // cache for a model that cannot hold one.
    expect(result.lanes[0]?.kind).toBe("fits");
  });

  it("does not count a reused model as a blocker for its own lane", () => {
    // Lane 1 reuses Y; lane 2 is a variant on other weights that still fits.
    const result = preflight({
      lanes: [lane("l1", "y:7b"), lane("l2", "b:7b")],
      models: [model("y:7b", 5), model("b:7b", 5)],
      running: [resident("y:7b", 5)],
      usableVramBytes: 27 * GB,
      fallbackCtx: CTX,
    });
    expect(result.lanes.map((v) => v.kind)).toEqual(["reuse", "fits"]);
    expect(result.needsUnload).toBe(false);
  });
});
