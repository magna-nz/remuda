import "./test/localStorage";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SESSIONS_STORAGE_KEY,
  createSession,
  loadSessions,
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
