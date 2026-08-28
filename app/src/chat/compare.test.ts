import { describe, expect, it } from "vitest";
import {
  effectiveLaneOptions,
  historyForLane,
  laneChipLabel,
  neitherLaneSetsSeed,
  randomSeed,
  swapsModel,
  winnerBy,
} from "./compare";
import type { CompareConfig, Message } from "./sessions";

function config(overrides: Partial<CompareConfig> = {}): CompareConfig {
  return {
    seed: 4417,
    lanes: [
      { model: "terse-v2:latest", modelfile: "terse-v2:latest" },
      { model: "terse-v2:latest", modelfile: "terse-v2:latest" },
    ],
    ...overrides,
  };
}

describe("seed pinning", () => {
  it("sends the pinned seed to both lanes", () => {
    const c = config();
    expect(effectiveLaneOptions(c, "a")?.seed).toBe(4417);
    expect(effectiveLaneOptions(c, "b")?.seed).toBe(4417);
  });

  it("leaves each lane's own options alone once unpinned", () => {
    const c = config({
      seed: null,
      lanes: [
        { model: "m", modelfile: null, options: { seed: 1, temperature: 0.2 } },
        { model: "m", modelfile: null },
      ],
    });
    expect(effectiveLaneOptions(c, "a")).toEqual({ seed: 1, temperature: 0.2 });
    expect(effectiveLaneOptions(c, "b")).toBeUndefined();
  });

  it("pins over a lane's own seed while the pin is on — that is what a pin is", () => {
    const c = config({
      lanes: [
        { model: "m", modelfile: null, options: { seed: 1 } },
        { model: "m", modelfile: null },
      ],
    });
    expect(effectiveLaneOptions(c, "a")?.seed).toBe(4417);
  });

  it("knows when there is a seed to pin over", () => {
    expect(neitherLaneSetsSeed(config().lanes)).toBe(true);
    expect(
      neitherLaneSetsSeed([
        { model: "m", modelfile: null, options: { seed: 9 } },
        { model: "m", modelfile: null },
      ]),
    ).toBe(false);
  });

  it("never re-draws the seed it was told to avoid", () => {
    // "Regenerate with a NEW seed" that redrew the old one would be the same
    // run wearing a different label.
    for (let i = 0; i < 200; i += 1) {
      expect(randomSeed(7)).not.toBe(7);
    }
  });
});

describe("per-lane history", () => {
  const messages: Message[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1", lane: "a" },
    { role: "assistant", content: "b1", lane: "b" },
    { role: "user", content: "q2" },
  ];

  it("gives a lane the shared turns and only its own replies", () => {
    expect(historyForLane(messages, "a").map((m) => m.content)).toEqual(["q1", "a1", "q2"]);
    expect(historyForLane(messages, "b").map((m) => m.content)).toEqual(["q1", "b1", "q2"]);
  });
});

describe("win markers", () => {
  it("marks per metric, in the right direction", () => {
    expect(winnerBy(68, 64, "higher")).toBe("a");
    expect(winnerBy(68, 64, "lower")).toBe("b");
  });

  it("wins nothing on a tie or a number the server didn't report", () => {
    // A tie is not a win, and neither is "we only measured one side".
    expect(winnerBy(64, 64, "higher")).toBeNull();
    expect(winnerBy(null, 64, "higher")).toBeNull();
    expect(winnerBy(64, undefined, "lower")).toBeNull();
  });
});

describe("lane identity", () => {
  it("names the variant and counts its overrides", () => {
    expect(laneChipLabel({ model: "terse-v2:latest", modelfile: "terse-v2:latest" })).toBe(
      "terse-v2",
    );
    expect(
      laneChipLabel({ model: "llama3.1:8b", modelfile: null, options: { temperature: 0.9 } }),
    ).toBe("llama3.1:8b · 1 override");
    expect(
      laneChipLabel({
        model: "llama3.1:8b",
        modelfile: null,
        options: { temperature: 0.9, topK: 12, seed: 1 },
      }),
    ).toBe("llama3.1:8b · 3 overrides");
  });

  it("knows when a run costs a model swap", () => {
    expect(swapsModel(config())).toBe(false);
    expect(
      swapsModel(
        config({
          lanes: [
            { model: "a:1", modelfile: null },
            { model: "b:1", modelfile: null },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("history hygiene", () => {
  it("drops a failed lane's empty reply rather than sending it as history", () => {
    const messages: Message[] = [
      { id: "m1", role: "user", content: "hello" },
      { id: "m2", role: "assistant", content: "", lane: "a" },
      { id: "m3", role: "assistant", content: "hi there", lane: "b" },
    ];
    // Lane A errored: its placeholder is empty and must not be re-sent.
    expect(historyForLane(messages, "a").map((m) => m.id)).toEqual(["m1"]);
    expect(historyForLane(messages, "b").map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("keeps a reply that produced only reasoning", () => {
    const messages: Message[] = [
      { id: "m1", role: "user", content: "hello" },
      { id: "m2", role: "assistant", content: "", thinking: "hmm", lane: "a" },
    ];
    expect(historyForLane(messages, "a").map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});
