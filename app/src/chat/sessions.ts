/**
 * Chat session model + persistence (SPEC.md §5.2, §6).
 *
 * A ChatSession remembers the effective model tag it ran on — across
 * unloads; the session's identity is its model (SPEC §5.3). Sessions live
 * in localStorage under a versioned key and are sorted most-recent first.
 * Corrupt or missing data degrades to an empty list, never a crash.
 */
import type { ChatMessage, RunOptions, ThinkLevel } from "../api/types";

export interface ChatSession {
  id: string;
  title: string;
  /** Effective tag it ran on — remembered across unloads. */
  model: string;
  messages: ChatMessage[];
  updatedAt: string; // ISO 8601
  /** Per-session sampling overrides sent on every request (SPEC §5.3). */
  options?: RunOptions;
  /** Reasoning effort for a thinking-capable model; absent means "off". */
  think?: ThinkLevel;
}

/**
 * Do not bump this. Every field added since v1 is optional, so a v1 payload
 * parses unchanged; a new key would orphan — i.e. delete — every existing
 * user's chat history for no gain.
 */
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

/**
 * Reading persisted data is a two-tier job, and the tiers must not be
 * confused.
 *
 * The *required* spine — id/title/model/updatedAt/messages, and each
 * message's role and content — is what makes a session a session; if any of
 * it is wrong the session is unreadable and gets dropped.
 *
 * The *optional* extras added after v1 — thinking, images, imageThumbs,
 * options, think — are not. A malformed one of those is dropped on its own
 * and the session survives, because throwing away a transcript over an
 * unrecognised sidecar field would be a data-loss bug wearing a validator's
 * clothes.
 */
function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

function coerceMessage(value: unknown): ChatMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  if (m.role !== "system" && m.role !== "user" && m.role !== "assistant") return null;
  if (typeof m.content !== "string") return null;
  const message: ChatMessage = { role: m.role, content: m.content };
  if (typeof m.thinking === "string") {
    message.thinking = m.thinking;
  }
  // `images` is never written to storage (see saveSessions), but a payload
  // from a build that did write them shouldn't be rejected for it.
  const images = stringArrayOrUndefined(m.images);
  if (images !== undefined) {
    message.images = images;
  }
  const thumbs = stringArrayOrUndefined(m.imageThumbs);
  if (thumbs !== undefined) {
    message.imageThumbs = thumbs;
  }
  return message;
}

const RUN_OPTION_KEYS: Array<keyof RunOptions> = [
  "temperature",
  "topP",
  "topK",
  "seed",
  "numPredict",
  "repeatPenalty",
  "numCtx",
];

function coerceOptions(value: unknown): RunOptions | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const options: RunOptions = {};
  let any = false;
  for (const key of RUN_OPTION_KEYS) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      options[key] = v;
      any = true;
    }
  }
  return any ? options : undefined;
}

function coerceThink(value: unknown): ThinkLevel | undefined {
  return value === "off" || value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;
}

function coerceSession(value: unknown): ChatSession | null {
  if (typeof value !== "object" || value === null) return null;
  const s = value as Record<string, unknown>;
  if (
    typeof s.id !== "string" ||
    typeof s.title !== "string" ||
    typeof s.model !== "string" ||
    typeof s.updatedAt !== "string" ||
    !Array.isArray(s.messages)
  ) {
    return null;
  }
  const messages: ChatMessage[] = [];
  for (const raw of s.messages) {
    const message = coerceMessage(raw);
    if (message === null) return null;
    messages.push(message);
  }
  const session: ChatSession = {
    id: s.id,
    title: s.title,
    model: s.model,
    messages,
    updatedAt: s.updatedAt,
  };
  const options = coerceOptions(s.options);
  if (options !== undefined) {
    session.options = options;
  }
  const think = coerceThink(s.think);
  if (think !== undefined) {
    session.think = think;
  }
  return session;
}

/** Load persisted sessions; corrupt or missing data starts empty. */
export function loadSessions(): ChatSession[] {
  try {
    const raw = window.localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const sessions: ChatSession[] = [];
    for (const entry of parsed) {
      const session = coerceSession(entry);
      if (session !== null) sessions.push(session);
    }
    return sortSessions(sessions);
  } catch {
    return [];
  }
}

/**
 * Storage-safe copy: raw base64 `images` are dropped, `imageThumbs` kept.
 *
 * localStorage caps around 5MB. A single full-size image is easily a megabyte
 * of base64, so persisting `images` would blow the quota — and setItem
 * failing is silent here, meaning one pasted screenshot would stop *all*
 * session saving without a word. Thumbnails are the persisted record; a
 * restored session shows the thumb and knows the full data is gone.
 */
function forStorage(session: ChatSession): ChatSession {
  if (!session.messages.some((m) => m.images !== undefined)) {
    return session;
  }
  return {
    ...session,
    messages: session.messages.map((m) => {
      if (m.images === undefined) return m;
      const { images: _dropped, ...rest } = m;
      return rest;
    }),
  };
}

export function saveSessions(sessions: ChatSession[]): void {
  try {
    window.localStorage.setItem(
      SESSIONS_STORAGE_KEY,
      JSON.stringify(sessions.map(forStorage)),
    );
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
