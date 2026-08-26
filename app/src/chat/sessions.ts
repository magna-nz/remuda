/**
 * Chat session model + persistence (SPEC.md §5.2, §6).
 *
 * A ChatSession remembers the effective model tag it ran on — across
 * unloads; the session's identity is its model (SPEC §5.3). Sessions live
 * in localStorage under a versioned key and are sorted most-recent first.
 * Corrupt or missing data degrades to an empty list, never a crash.
 */
import type { ChatMessage } from "../api/types";

export interface ChatSession {
  id: string;
  title: string;
  /** Effective tag it ran on — remembered across unloads. */
  model: string;
  messages: ChatMessage[];
  updatedAt: string; // ISO 8601
}

export const SESSIONS_STORAGE_KEY = "remuda.sessions.v1";

/** Title before the first user message lands (SPEC §5.2). */
export const UNTITLED = "New chat";

const TITLE_MAX = 40;

/** Derive a session title from its first user message: trimmed, ~40 chars. */
export function titleFor(firstUserMessage: string): string {
  const flat = firstUserMessage.trim().replace(/\s+/g, " ");
  if (flat.length === 0) return UNTITLED;
  if (flat.length <= TITLE_MAX) return flat;
  return `${flat.slice(0, TITLE_MAX).trimEnd()}…`;
}

/** Most-recent first (SPEC §5.2). Stable for equal timestamps. */
export function sortSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createSession(model: string, now: Date = new Date()): ChatSession {
  return {
    id: `s-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    title: UNTITLED,
    model,
    messages: [],
    updatedAt: now.toISOString(),
  };
}

function isMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    (m.role === "system" || m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string"
  );
}

function isSession(value: unknown): value is ChatSession {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.title === "string" &&
    typeof s.model === "string" &&
    typeof s.updatedAt === "string" &&
    Array.isArray(s.messages) &&
    s.messages.every(isMessage)
  );
}

/** Load persisted sessions; corrupt or missing data starts empty. */
export function loadSessions(): ChatSession[] {
  try {
    const raw = window.localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortSessions(parsed.filter(isSession));
  } catch {
    return [];
  }
}

export function saveSessions(sessions: ChatSession[]): void {
  try {
    window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Quota/private-mode failures: sessions simply won't survive a restart.
  }
}

/** Compact relative time for session rows: "now", "5m", "1h", "2d". */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Mockup's shortTag: ":latest" adds nothing in a narrow row. */
export function shortTag(tag: string): string {
  return tag.replace(/:latest$/, "");
}
