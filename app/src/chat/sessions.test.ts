import "./test/localStorage";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SESSIONS_STORAGE_KEY,
  createSession,
  loadSessions,
  newMessageId,
  relativeTime,
  saveSessions,
  shortTag,
  sortSessions,
  titleFor,
  type ChatSession,
} from "./sessions";

function fixtureSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s-1",
    title: "Undo a git commit",
    model: "llama3.1:8b",
    messages: [
      { role: "user", content: "How do I undo the last commit?" },
      { role: "assistant", content: "git reset --soft HEAD~1" },
    ],
    updatedAt: "2026-08-26T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("sessions persistence", () => {
  it("round-trips sessions through localStorage", () => {
    const a = fixtureSession({ id: "s-a", updatedAt: "2026-08-26T09:00:00.000Z" });
    const b = fixtureSession({ id: "s-b", title: "Explain this regex", updatedAt: "2026-08-26T11:00:00.000Z" });
    saveSessions([a, b]);
    // Restored most-recent first regardless of stored order (SPEC §5.2).
    expect(loadSessions()).toEqual([b, a]);
  });

  it("starts empty when nothing is stored", () => {
    expect(loadSessions()).toEqual([]);
  });

  it("tolerates corrupt JSON by starting empty", () => {
    window.localStorage.setItem(SESSIONS_STORAGE_KEY, "{definitely not json");
    expect(loadSessions()).toEqual([]);
  });

  it("tolerates non-array JSON and drops malformed entries", () => {
    window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify({ nope: true }));
    expect(loadSessions()).toEqual([]);

    const good = fixtureSession();
    window.localStorage.setItem(
      SESSIONS_STORAGE_KEY,
      JSON.stringify([good, { id: "bad" }, 42, { ...good, id: "s-2", messages: [{ role: "alien" }] }]),
    );
    expect(loadSessions()).toEqual([good]);
  });
});

describe("forward/backward compatibility of the stored shape", () => {
  it("loads a v1 session that has none of the newer fields", () => {
    // Byte-for-byte what a pre-thinking, pre-vision build wrote. The storage
    // key is unchanged, so this must survive verbatim.
    const v1 = {
      id: "s-v1",
      title: "Undo a git commit",
      model: "llama3.1:8b",
      messages: [
        { role: "user", content: "How do I undo the last commit?" },
        { role: "assistant", content: "git reset --soft HEAD~1" },
      ],
      updatedAt: "2026-08-26T10:00:00.000Z",
    };
    window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify([v1]));
    const [loaded] = loadSessions();
    expect(loaded).toEqual(v1);
    expect(loaded.options).toBeUndefined();
    expect(loaded.think).toBeUndefined();
  });

  it("round-trips options and think", () => {
    const s = fixtureSession({
      options: { temperature: 0.2, numCtx: 8192 },
      think: "high",
    });
    saveSessions([s]);
    expect(loadSessions()).toEqual([s]);
  });

  it("drops a malformed extra field but keeps the session", () => {
    // The transcript is the valuable thing. A junk sidecar field is not a
    // reason to throw a conversation away.
    const good = fixtureSession();
    window.localStorage.setItem(
      SESSIONS_STORAGE_KEY,
      JSON.stringify([
        {
          ...good,
          options: { temperature: "hot", topP: 0.9, nonsense: true },
          think: "very hard",
          messages: [
            { role: "user", content: "hi", images: "not-an-array" },
            { role: "assistant", content: "hey", thinking: 42, imageThumbs: [1, 2] },
          ],
        },
      ]),
    );
    const [loaded] = loadSessions();
    expect(loaded.id).toBe(good.id);
    expect(loaded.options).toEqual({ topP: 0.9 });
    expect(loaded.think).toBeUndefined();
    expect(loaded.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
    ]);
  });

  it("loads a session whose messages carry no ids, keeping every message", () => {
    // Every build before message ids wrote exactly this. Ids are optional,
    // so the transcript must come back intact and *unbackfilled* — inventing
    // one on load would be a silent rewrite of the user's history.
    const noIds = {
      id: "s-noids",
      title: "Undo a git commit",
      model: "llama3.1:8b",
      messages: [
        { role: "user", content: "How do I undo the last commit?" },
        { role: "assistant", content: "git reset --soft HEAD~1" },
      ],
      updatedAt: "2026-08-26T10:00:00.000Z",
    };
    window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify([noIds]));
    const [loaded] = loadSessions();
    expect(loaded).toEqual(noIds);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].id).toBeUndefined();
    expect(loaded.messages[1].id).toBeUndefined();
  });

  it("keeps a well-formed message id and drops a malformed one, message and all", () => {
    const good = fixtureSession();
    window.localStorage.setItem(
      SESSIONS_STORAGE_KEY,
      JSON.stringify([
        {
          ...good,
          messages: [
            { id: "m-keep", role: "user", content: "hi" },
            { id: 42, role: "assistant", content: "hey" },
            { id: "", role: "assistant", content: "still here" },
            { id: { nope: true }, role: "assistant", content: "and here" },
          ],
        },
      ]),
    );
    const [loaded] = loadSessions();
    // A junk id is a junk *optional*: it goes, the message stays (SPEC §6).
    expect(loaded.messages).toEqual([
      { id: "m-keep", role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
      { role: "assistant", content: "still here" },
      { role: "assistant", content: "and here" },
    ]);
    expect(loaded.messages[1].id).toBeUndefined();
    expect(loaded.messages[2].id).toBeUndefined();
    expect(loaded.messages[3].id).toBeUndefined();
  });

  it("writes message ids to storage — a lane reply is unreadable without one", () => {
    // This deliberately reverses the earlier build's rule. Ids used to be
    // stripped because they only addressed a live stream. Compare mode is
    // per-session state that survives a restart (SPEC-tuning T2), `lane` is
    // what tells a turn's two replies apart, and every affordance that acts
    // on one reply — regenerate, copy as curl — addresses it by id. They are
    // optional on the way in, so older payloads still load.
    const s = fixtureSession({
      messages: [
        { id: "m-1", role: "user", content: "hi" },
        { id: "m-2", role: "assistant", content: "hey" },
      ],
    });
    saveSessions([s]);
    const stored = window.localStorage.getItem(SESSIONS_STORAGE_KEY) ?? "";
    expect(stored).toContain('"id":"m-1"');
    expect(loadSessions()[0].messages).toEqual([
      { id: "m-1", role: "user", content: "hi" },
      { id: "m-2", role: "assistant", content: "hey" },
    ]);
    // …and the in-memory session the provider is still using is untouched.
    expect(s.messages[0].id).toBe("m-1");
  });

  it("gives every new message a distinct id", () => {
    expect(newMessageId()).not.toBe(newMessageId());
    expect(newMessageId()).toMatch(/^m-/);
  });

  it("round-trips a compare session with both lanes and both replies intact", () => {
    // Compare mode is per-session state that survives a restart (SPEC-tuning
    // T2). Without `lane` on the way back, a reloaded A/B session is two
    // anonymous replies to one prompt and the two columns can't be rebuilt.
    const s = fixtureSession({
      messages: [
        { id: "m-u", role: "user", content: "Reply to this customer" },
        { id: "m-a", role: "assistant", content: "Terse.", lane: "a" },
        { id: "m-b", role: "assistant", content: "Warmer.", lane: "b" },
      ],
      compare: {
        seed: 4417,
        lanes: [
          { model: "terse-v2:latest", modelfile: "terse-v2:latest", options: { temperature: 0.4 } },
          { model: "llama3.1:8b", modelfile: null, think: "low" },
        ],
      },
    });
    saveSessions([s]);
    expect(loadSessions()).toEqual([s]);
  });

  it("drops a half-formed compare block and keeps the transcript", () => {
    // Optional tier (SPEC §6): one lane and no lane are both unrenderable,
    // and falling back to the single-lane chat the session already is beats
    // throwing the conversation away over it.
    const good = fixtureSession();
    const cases = [
      { seed: 1, lanes: [{ model: "a", modelfile: null }] },
      { seed: 1, lanes: [{ model: "a", modelfile: null }, { modelfile: null }] },
      { seed: 1, lanes: "both of them" },
      "compare",
    ];
    for (const compare of cases) {
      window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify([{ ...good, compare }]));
      const [loaded] = loadSessions();
      expect(loaded.compare).toBeUndefined();
      expect(loaded.messages).toHaveLength(2);
    }
  });

  it("treats an unusable pinned seed as unpinned rather than as NaN", () => {
    const good = fixtureSession();
    window.localStorage.setItem(
      SESSIONS_STORAGE_KEY,
      JSON.stringify([
        {
          ...good,
          compare: {
            seed: "four thousand",
            lanes: [
              { model: "a", modelfile: null },
              { model: "b", modelfile: null },
            ],
          },
        },
      ]),
    );
    const [loaded] = loadSessions();
    expect(loaded.compare?.seed).toBeNull();
    expect(loaded.compare?.lanes).toHaveLength(2);
  });

  it("keeps a well-formed lane and drops a junk one, message and all", () => {
    const good = fixtureSession();
    window.localStorage.setItem(
      SESSIONS_STORAGE_KEY,
      JSON.stringify([
        {
          ...good,
          messages: [
            { role: "assistant", content: "a side", lane: "a" },
            { role: "assistant", content: "c side", lane: "c" },
          ],
        },
      ]),
    );
    expect(loadSessions()[0].messages).toEqual([
      { role: "assistant", content: "a side", lane: "a" },
      { role: "assistant", content: "c side" },
    ]);
  });

  it("loads a session from a build that had no ids, no lanes and no compare", () => {
    // Byte-for-byte what a pre-T2 build wrote. The storage key hasn't moved,
    // so this has to come back untouched and unbackfilled.
    const old = {
      id: "s-old",
      title: "Undo a git commit",
      model: "llama3.1:8b",
      messages: [
        { role: "user", content: "How do I undo the last commit?" },
        { role: "assistant", content: "git reset --soft HEAD~1" },
      ],
      updatedAt: "2026-08-26T10:00:00.000Z",
      options: { temperature: 0.7 },
    };
    window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify([old]));
    const [loaded] = loadSessions();
    expect(loaded).toEqual(old);
    expect(loaded.compare).toBeUndefined();
    expect(loaded.messages.every((m) => m.id === undefined && m.lane === undefined)).toBe(true);
  });

  it("drops an options object with nothing usable in it, keeping the session", () => {
    const good = fixtureSession();
    window.localStorage.setItem(
      SESSIONS_STORAGE_KEY,
      JSON.stringify([{ ...good, options: [1, 2, 3] }]),
    );
    const [loaded] = loadSessions();
    expect(loaded).toEqual(good);
  });
});

describe("image persistence", () => {
  const RAW = "iVBORw0KGgoAAAANSUhEUg";
  const THUMB = "data:image/png;base64,iVBORw0KGg";

  function withImages(): ChatSession {
    return fixtureSession({
      messages: [
        { role: "user", content: "what is this", images: [RAW], imageThumbs: [THUMB] },
        { role: "assistant", content: "a cat" },
      ],
    });
  }

  it("strips raw images on the way out and persists only the thumbs", () => {
    // localStorage caps around 5MB and setItem failing here is silent, so a
    // single full-size base64 image would stop ALL session saving.
    saveSessions([withImages()]);
    const stored = window.localStorage.getItem(SESSIONS_STORAGE_KEY) ?? "";
    expect(stored).not.toContain(RAW);
    expect(stored).toContain(THUMB);
    expect(stored).not.toContain('"images"');
  });

  it("restores a session with thumbs and no images", () => {
    saveSessions([withImages()]);
    const [loaded] = loadSessions();
    expect(loaded.messages[0].images).toBeUndefined();
    expect(loaded.messages[0].imageThumbs).toEqual([THUMB]);
    expect(loaded.messages[0].content).toBe("what is this");
  });

  it("does not mutate the in-memory sessions it was handed", () => {
    // The provider keeps using this array after the debounced save.
    const session = withImages();
    saveSessions([session]);
    expect(session.messages[0].images).toEqual([RAW]);
  });
});

describe("createSession / titles / sorting", () => {
  it("creates an untitled session bound to the given model", () => {
    const s = createSession("support-bot:latest");
    expect(s.title).toBe("New chat");
    expect(s.model).toBe("support-bot:latest");
    expect(s.messages).toEqual([]);
    expect(Date.parse(s.updatedAt)).not.toBeNaN();
    expect(createSession("x").id).not.toBe(createSession("x").id);
  });

  it("titles from the first user message, truncated to ~40 chars", () => {
    expect(titleFor("Undo a git commit")).toBe("Undo a git commit");
    expect(titleFor("  spaced   out\n\nmessage  ")).toBe("spaced out message");
    const long = "Write a regex to pull the ISO timestamp from log lines please";
    const title = titleFor(long);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(41);
    expect(titleFor("   ")).toBe("New chat");
  });

  it("sorts most-recent first", () => {
    const old = fixtureSession({ id: "old", updatedAt: "2026-08-20T00:00:00.000Z" });
    const recent = fixtureSession({ id: "recent", updatedAt: "2026-08-26T00:00:00.000Z" });
    expect(sortSessions([old, recent]).map((s) => s.id)).toEqual(["recent", "old"]);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-08-26T12:00:00.000Z");

  it("buckets into now / minutes / hours / days", () => {
    expect(relativeTime("2026-08-26T11:59:30.000Z", now)).toBe("now");
    expect(relativeTime("2026-08-26T11:55:00.000Z", now)).toBe("5m");
    expect(relativeTime("2026-08-26T10:00:00.000Z", now)).toBe("2h");
    expect(relativeTime("2026-08-24T12:00:00.000Z", now)).toBe("2d");
    expect(relativeTime("garbage", now)).toBe("");
  });
});

describe("shortTag", () => {
  it("drops only a trailing :latest", () => {
    expect(shortTag("support-bot:latest")).toBe("support-bot");
    expect(shortTag("llama3.1:8b")).toBe("llama3.1:8b");
  });
});
