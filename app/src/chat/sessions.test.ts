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
