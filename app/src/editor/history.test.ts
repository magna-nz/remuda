import "../chat/test/localStorage";
/**
 * The Modelfile snapshot ring (SPEC-tuning.md T1): content addressing, the
 * per-tag cap, and the two-tier read of persisted data.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_STORAGE_KEY,
  TAG_RING_CAP,
  TOTAL_CAP,
  appendSnapshot,
  hashText,
  loadHistory,
  saveHistory,
  snapshotsForTag,
  type ModelfileSnapshot,
} from "./history";

function snap(overrides: Partial<ModelfileSnapshot> & { id: string }): ModelfileSnapshot {
  return {
    tag: "terse-v2:latest",
    rawText: `FROM llama3.1:8b\nSYSTEM """${overrides.id}"""\n`,
    savedAt: "2026-01-01T00:00:00.000Z",
    kind: "save",
    ...overrides,
  };
}

describe("hashText", () => {
  it("is stable, and different for different text", () => {
    expect(hashText("FROM llama3.1:8b\n")).toBe(hashText("FROM llama3.1:8b\n"));
    expect(hashText("FROM llama3.1:8b\n")).not.toBe(hashText("FROM mistral:7b\n"));
    // Whitespace is text: a trailing newline is a real difference.
    expect(hashText("a")).not.toBe(hashText("a\n"));
  });
});

describe("appendSnapshot", () => {
  it("records a changed Modelfile", () => {
    const first = appendSnapshot([], snap({ id: "a" }));
    const second = appendSnapshot(first, snap({ id: "b" }));
    expect(second.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("content-addresses: re-saving identical text adds no entry", () => {
    const ring = appendSnapshot([], snap({ id: "a", rawText: "FROM llama3.1:8b\n" }));
    const again = appendSnapshot(ring, snap({ id: "b", rawText: "FROM llama3.1:8b\n" }));
    expect(again).toBe(ring); // same reference — nothing was written
    expect(again).toHaveLength(1);
  });

  it("dedupes against the tag's newest only — going back to earlier text is a change", () => {
    let ring = appendSnapshot([], snap({ id: "a", rawText: "one\n" }));
    ring = appendSnapshot(ring, snap({ id: "b", rawText: "two\n" }));
    ring = appendSnapshot(ring, snap({ id: "c", rawText: "one\n" }));
    expect(ring.map((s) => s.id)).toEqual(["c", "b", "a"]);
  });

  it("identical text under a different tag is its own snapshot", () => {
    const ring = appendSnapshot([], snap({ id: "a", rawText: "FROM llama3.1:8b\n" }));
    const forked = appendSnapshot(
      ring,
      snap({ id: "b", tag: "other:latest", rawText: "FROM llama3.1:8b\n", kind: "saveas" }),
    );
    expect(forked).toHaveLength(2);
  });

  it(`caps a tag's ring at ${TAG_RING_CAP}, evicting oldest first, and leaves other tags alone`, () => {
    let ring: ModelfileSnapshot[] = [snap({ id: "solo", tag: "lonely:latest", rawText: "solo\n" })];
    for (let i = 0; i < TAG_RING_CAP + 5; i++) {
      ring = appendSnapshot(ring, snap({ id: `s${i}`, rawText: `text ${i}\n` }));
    }
    const kept = snapshotsForTag(ring, "terse-v2:latest");
    expect(kept).toHaveLength(TAG_RING_CAP);
    expect(kept[0]!.id).toBe(`s${TAG_RING_CAP + 4}`); // newest survives
    expect(kept[kept.length - 1]!.id).toBe("s5"); // s0..s4 evicted, oldest first
    // A tag with a single snapshot is never touched by another tag's churn.
    expect(snapshotsForTag(ring, "lonely:latest").map((s) => s.id)).toEqual(["solo"]);
  });

  it("the global lid never evicts a tag's last remaining snapshot", () => {
    // One busy tag at its cap, plus enough single-snapshot tags to blow the
    // total. The busy tag gives ground; the singletons do not.
    let ring: ModelfileSnapshot[] = [];
    for (let i = 0; i < TOTAL_CAP; i++) {
      ring = appendSnapshot(ring, snap({ id: `solo${i}`, tag: `m${i}:latest`, rawText: `t${i}\n` }));
    }
    for (let i = 0; i < TAG_RING_CAP; i++) {
      ring = appendSnapshot(ring, snap({ id: `busy${i}`, rawText: `busy ${i}\n` }));
    }
    for (let i = 0; i < TOTAL_CAP; i++) {
      expect(snapshotsForTag(ring, `m${i}:latest`)).toHaveLength(1);
    }
    // Everything the lid took came from the tag that had more than one — and
    // it stopped at that tag's last snapshot rather than emptying it, so the
    // ring sits one over the lid instead of losing a model's only record.
    expect(snapshotsForTag(ring, "terse-v2:latest")).toHaveLength(1);
    expect(ring.length).toBe(TOTAL_CAP + 1);
  });
});

describe("loadHistory / saveHistory", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips", () => {
    const ring = [snap({ id: "a" }), snap({ id: "b", savedAt: "2025-12-31T00:00:00.000Z" })];
    saveHistory(ring);
    expect(loadHistory().map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("missing or unparseable storage starts empty, never throws", () => {
    expect(loadHistory()).toEqual([]);
    window.localStorage.setItem(HISTORY_STORAGE_KEY, "{not json");
    expect(loadHistory()).toEqual([]);
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ nope: true }));
    expect(loadHistory()).toEqual([]);
  });

  it("drops one corrupt record without taking the rest of the ring with it", () => {
    window.localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify([
        snap({ id: "good-1", savedAt: "2026-01-03T00:00:00.000Z" }),
        { id: "bad", tag: "terse-v2:latest", savedAt: "2026-01-02T00:00:00.000Z" }, // no rawText
        { id: 7, tag: "terse-v2:latest", rawText: "x", savedAt: "2026-01-02T00:00:00.000Z" },
        "not even an object",
        null,
        snap({ id: "good-2", savedAt: "2026-01-01T00:00:00.000Z" }),
      ]),
    );
    expect(loadHistory().map((s) => s.id)).toEqual(["good-1", "good-2"]);
  });

  it("a malformed optional field is dropped, the snapshot survives", () => {
    window.localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify([
        { ...snap({ id: "a" }), kind: "teleport", parentId: 12 },
      ]),
    );
    const [loaded] = loadHistory();
    expect(loaded!.id).toBe("a");
    expect(loaded!.kind).toBe("save"); // unrecognised kind degrades, not discards
    expect(loaded!.parentId).toBeUndefined();
  });

  it("a quota failure is swallowed — history must never break saving", () => {
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveHistory([snap({ id: "a" })])).not.toThrow();
    setItem.mockRestore();
  });
});
