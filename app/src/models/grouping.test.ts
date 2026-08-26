import { describe, expect, it } from "vitest";
import { displayKey, groupByModel, quantLabel, stripQuant, variantCount } from "./grouping";
import { makeModel } from "../ui/test/FakeClient";
import type { ModelGroup } from "../api/types";

function base(tag: string, quantization: string, extra: Partial<ModelGroup> = {}): ModelGroup {
  return { base: makeModel({ tag, quantization }), variants: [], ...extra };
}

describe("stripQuant", () => {
  it("strips a quant baked into the repo name (locally-created models)", () => {
    expect(stripQuant("llama3.1-70b-instruct-q4:latest", "Q4_K_M")).toBe("llama3.1-70b-instruct:latest");
    expect(stripQuant("llama3.1-70b-instruct-q8:latest", "Q8_0")).toBe("llama3.1-70b-instruct:latest");
  });

  it("strips a quant carried in the tag part (upstream pulls)", () => {
    expect(stripQuant("llama4:8b-q4_K_M", "Q4_K_M")).toBe("llama4:8b");
    expect(stripQuant("gemma3:27b-it-q8_0", "Q8_0")).toBe("gemma3:27b-it");
  });

  it("accepts the full level, its dashed form, and the bare short form", () => {
    expect(stripQuant("m-q5_k_m:latest", "Q5_K_M")).toBe("m:latest");
    expect(stripQuant("m-q5-k-m:latest", "Q5_K_M")).toBe("m:latest");
    expect(stripQuant("m-q5:latest", "Q5_K_M")).toBe("m:latest");
    expect(stripQuant("m-fp16:latest", "F16")).toBe("m:latest");
  });

  it("returns null when the tag carries no quant marker", () => {
    expect(stripQuant("mistral-small-24b:latest", "Q5_K_M")).toBeNull();
    expect(stripQuant("llama3.1:8b", "Q4_K_M")).toBeNull();
  });

  it("falls back to the tag's own marker when the server reports nothing", () => {
    expect(stripQuant("some-q4:latest", "")).toBe("some:latest");
    expect(stripQuant("some-q4:latest", "unknown")).toBe("some:latest");
  });

  it("falls back to the tag's marker when the reported level contradicts it", () => {
    // Real case: `ollama create` copies the parent's details, so a 31.5 GB Q8
    // build reports Q4_K_M. Group by what the name says.
    expect(stripQuant("llama3.1-70b-instruct-q8:latest", "Q4_K_M")).toBe("llama3.1-70b-instruct:latest");
  });

  it("only matches on a token boundary, never mid-word", () => {
    // "seq40" contains "q4" but isn't a quant marker.
    expect(stripQuant("seq40:latest", "Q4_K_M")).toBeNull();
    expect(stripQuant("q4finetune:latest", "Q4_K_M")).toBeNull();
  });

  it("never strips a tag down to nothing", () => {
    expect(stripQuant("q4:latest", "Q4_K_M")).toBeNull();
  });
});

describe("groupByModel", () => {
  it("folds the quant variants of one model into a single entry", () => {
    const entries = groupByModel([
      base("llama3.1-70b-instruct-q4:latest", "Q4_K_M"),
      base("llama3.1-70b-instruct-q8:latest", "Q8_0"),
    ]);

    expect(entries).toHaveLength(1);
    expect(displayKey(entries[0]!.key)).toBe("llama3.1-70b-instruct");
    expect(entries[0]!.quants.map((q) => q.quantization)).toEqual(["Q4_K_M", "Q8_0"]);
    expect(entries[0]!.quants.map((q) => q.tag)).toEqual([
      "llama3.1-70b-instruct-q4:latest",
      "llama3.1-70b-instruct-q8:latest",
    ]);
  });

  it("keeps models apart when only family metadata would have merged them", () => {
    // Both report mistral/24B — grouping on that would collapse a real
    // distinction. The names differ, so they stay separate.
    const entries = groupByModel([
      base("mistral-small-24b-code-q5:latest", "Q5_K_M"),
      base("mistral-small-24b:latest", "Q5_K_M"),
    ]);

    expect(entries.map((e) => displayKey(e.key))).toEqual(["mistral-small-24b-code", "mistral-small-24b"]);
  });

  it("leaves a tag with no quant marker as its own single-quant model", () => {
    const entries = groupByModel([base("mistral-small-24b:latest", "Q5_K_M")]);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe("mistral-small-24b:latest");
    expect(entries[0]!.quants).toHaveLength(1);
  });

  it("refuses to merge when two tags collide on the same (model, quant) cell", () => {
    // `foo:latest` is itself Q4_K_M, so `foo-q4:latest` stripping down to
    // `foo:latest` would put two different models in the one Q4_K_M cell.
    const entries = groupByModel([
      base("foo:latest", "Q4_K_M"),
      base("foo-q4:latest", "Q4_K_M"),
    ]);

    expect(entries.map((e) => e.key)).toEqual(["foo:latest", "foo-q4:latest"]);
    expect(entries.every((e) => e.quants.length === 1)).toBe(true);
  });

  it("guards the collision in either arrival order", () => {
    const entries = groupByModel([
      base("foo-q4:latest", "Q4_K_M"),
      base("foo:latest", "Q4_K_M"),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.quants.length === 1)).toBe(true);
  });

  it("merges an unsuffixed tag with a suffixed one when their quants differ", () => {
    // `llama3.1-70b` (Q4) and `llama3.1-70b-q8` (Q8) are one model at two
    // quantisations — different cells, so they belong together.
    const entries = groupByModel([
      base("llama3.1-70b:latest", "Q4_K_M"),
      base("llama3.1-70b-q8:latest", "Q4_K_M"),
    ]);

    expect(entries).toHaveLength(1);
    expect(displayKey(entries[0]!.key)).toBe("llama3.1-70b");
    // The q8 build's reported level is wrong; the tag's marker is believed.
    expect(entries[0]!.quants.map((q) => q.quantization)).toEqual(["Q4_K_M", "Q8"]);
    expect(entries[0]!.quants[1]!.reportedQuantization).toBe("Q4_K_M");
  });

  it("takes an unsuffixed tag as a further quantisation of the same model", () => {
    const entries = groupByModel([
      base("foo-q4:latest", "Q4_K_M"),
      base("foo-q8:latest", "Q8_0"),
      base("foo:latest", "Q5_K_M"),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.quants.map((q) => q.quantization)).toEqual(["Q4_K_M", "Q8_0", "Q5_K_M"]);
  });

  it("attaches each tuned Modelfile to the exact quant it was built FROM", () => {
    const strict = makeModel({ tag: "qwen-strict:latest", isVariant: true, base: "qwen-coding-q4:latest" });
    const entries = groupByModel([
      { base: makeModel({ tag: "qwen-coding-q4:latest", quantization: "Q4_K_M" }), variants: [strict] },
      base("qwen-coding-q8:latest", "Q8_0"),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.quants[0]!.variants.map((v) => v.tag)).toEqual(["qwen-strict:latest"]);
    expect(entries[0]!.quants[1]!.variants).toEqual([]);
    expect(variantCount(entries[0]!)).toBe(1);
  });
});

describe("quantLabel", () => {
  it("keeps the reported level when the tag agrees with it", () => {
    expect(quantLabel("llama4:8b-q4_K_M", "Q4_K_M")).toBe("Q4_K_M");
    // A bare "q4" is a less specific form of the same thing, not a conflict.
    expect(quantLabel("model-q4:latest", "Q4_K_M")).toBe("Q4_K_M");
  });

  it("believes the tag when the reported level contradicts it", () => {
    expect(quantLabel("llama3.1-70b-instruct-q8:latest", "Q4_K_M")).toBe("Q8");
  });

  it("falls back to the reported level when the tag names no quant", () => {
    expect(quantLabel("mistral-small-24b:latest", "Q5_K_M")).toBe("Q5_K_M");
  });
});
