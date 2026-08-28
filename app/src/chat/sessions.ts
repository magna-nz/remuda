/**
 * Chat session model + persistence (SPEC.md §5.2, §6).
 *
 * A ChatSession remembers the effective model tag it ran on — across
 * unloads; the session's identity is its model (SPEC §5.3). Sessions live
 * in localStorage under a versioned key and are sorted most-recent first.
 * Corrupt or missing data degrades to an empty list, never a crash.
 */
import type { ChatMessage, RunOptions, ThinkLevel } from "../api/types";

/**
 * A transcript entry: the wire shape plus an optional local identity.
 *
 * `id` exists so a streamed reply can be routed to *a* message rather than
 * to "whichever one is last" — which is the only thing that made a second
 * concurrent generation impossible (SPEC-tuning T2). It is:
 *
 * - **optional**, because sessions written by every earlier build have none
 *   and the storage key does not move (SPEC §6). A message without an id
 *   loads intact and is never backfilled.
 * - **local**, never sent to Ollama (`forWire` in ui/state.tsx strips it)
 *   and never written to storage (`forStorage` below strips it too). Ids
 *   are only meaningful for the lifetime of an in-flight generation, and
 *   persisting them would change the stored bytes for no gain.
 */
export interface Message extends ChatMessage {
  id?: string;
  /**
   * Which A/B lane produced this reply (SPEC-tuning T2). Absent on every
   * single-lane message, and absent on the *user* message of a compare turn
   * — one prompt is sent once and stored once; only the two assistant
   * replies are lane-bound.
   */
  lane?: Lane;
}

/** The two A/B lanes (SPEC-tuning T2). */
export type Lane = "a" | "b";

/** Everything that makes one lane of an A/B run its own configuration. */
export interface LaneConfig {
  /** Effective tag this lane runs. The two lanes may name different models. */
  model: string;
  /** Variant tag this lane runs; null means the base/"OG" model. Display only. */
  modelfile: string | null;
  /** Sampling overrides for this lane alone. */
  options?: RunOptions;
  /** Reasoning effort for this lane alone; absent means "off". */
  think?: ThinkLevel;
}

/**
 * Compare mode, per session and persisted with it (SPEC-tuning T2).
 *
 * `seed` is pinned for the *pair*: comparing two configurations under two
 * different seeds measures sampling noise and nothing else. `null` means
 * unpinned — each lane then runs on whatever seed its own options name, or
 * none at all, and the bar says so.
 */
export interface CompareConfig {
  seed: number | null;
  lanes: [LaneConfig, LaneConfig];
}

/** A fresh message identity. Local and short-lived; see `Message.id`. */
export function newMessageId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ChatSession {
  id: string;
  title: string;
  /** Effective tag it ran on — remembered across unloads. */
  model: string;
  messages: Message[];
  updatedAt: string; // ISO 8601
  /** Per-session sampling overrides sent on every request (SPEC §5.3). */
  options?: RunOptions;
  /** Reasoning effort for a thinking-capable model; absent means "off". */
  think?: ThinkLevel;
  /**
   * A/B compare mode (SPEC-tuning T2). Its presence *is* the toggle: a
   * session with no `compare` is an ordinary single-lane chat, which is
   * every session written before this field existed.
   */
  compare?: CompareConfig;
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
 * id, options, think — are not. A malformed one of those is dropped on its
 * own and the session survives, because throwing away a transcript over an
 * unrecognised sidecar field would be a data-loss bug wearing a validator's
 * clothes.
 */
function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

function coerceMessage(value: unknown): Message | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  // "tool" included deliberately: ChatMessage.role was widened for T3, and a
  // role this list rejects escalates to dropping the ENTIRE session below —
  // a data-loss bug wearing a validator's clothes, exactly as this file warns.
  if (m.role !== "system" && m.role !== "user" && m.role !== "assistant" && m.role !== "tool") {
    return null;
  }
  if (typeof m.content !== "string") return null;
  const message: Message = { role: m.role, content: m.content };
  // Optional: a non-string or empty id is dropped on its own and the message
  // survives (SPEC §6). Sessions written before ids existed have none, and
  // one is never backfilled — inventing one would rewrite the user's history.
  if (typeof m.id === "string" && m.id !== "") {
    message.id = m.id;
  }
  // Same tier: an unrecognised lane is dropped and the reply stays, which is
  // also what a session written before compare mode looks like.
  if (m.lane === "a" || m.lane === "b") {
    message.lane = m.lane;
  }
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

/**
 * Compare mode off a stored payload (SPEC-tuning T2).
 *
 * Optional-tier, like `options` and `think`: anything short of two complete
 * lanes drops the whole `compare` block and leaves the transcript alone. A
 * half-formed compare would render one lane against nothing, which is worse
 * than falling back to the single-lane chat the session already is.
 */
function coerceLaneConfig(value: unknown): LaneConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.model !== "string" || raw.model === "") return null;
  const lane: LaneConfig = {
    model: raw.model,
    modelfile: typeof raw.modelfile === "string" && raw.modelfile !== "" ? raw.modelfile : null,
  };
  const options = coerceOptions(raw.options);
  if (options !== undefined) {
    lane.options = options;
  }
  const think = coerceThink(raw.think);
  if (think !== undefined) {
    lane.think = think;
  }
  return lane;
}

function coerceCompare(value: unknown): CompareConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.lanes) || raw.lanes.length !== 2) return undefined;
  const a = coerceLaneConfig(raw.lanes[0]);
  const b = coerceLaneConfig(raw.lanes[1]);
  if (a === null || b === null) return undefined;
  // A non-finite seed is "not pinned", never NaN on the wire.
  const seed = typeof raw.seed === "number" && Number.isFinite(raw.seed) ? raw.seed : null;
  return { seed, lanes: [a, b] };
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
  const messages: Message[] = [];
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
  const compare = coerceCompare(s.compare);
  if (compare !== undefined) {
    session.compare = compare;
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
 *
 * `id` and `lane` *are* written, and that is a deliberate change from the
 * build that introduced ids. Compare mode is per-session state that survives
 * a restart (SPEC-tuning T2), and `lane` is what tells the two replies of a
 * turn apart — strip it and a reloaded A/B session is two anonymous replies
 * to one prompt. `lane` needs `id` beside it: the reply overflow menu and a
 * regenerate both address a message by id. Both are optional on the way back
 * in, so a session written by any earlier build still loads (SPEC §6).
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
