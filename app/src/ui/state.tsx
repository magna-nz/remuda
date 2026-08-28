/**
 * Remuda's client-side store (SPEC.md §5, §5.1, §5.6, §9).
 *
 * A small React context — no external state library. Holds the OllamaClient
 * instance, server status (polled every 5s), the installed model list
 * (grouped into base + variants for the load pane), the currently loaded
 * selection, keep_alive, which top-level view is showing (chat, modelfile,
 * pull, or settings), persisted settings (SPEC §5.6), and the saved chat
 * sessions (SPEC §5.2, §6) with the one in-flight generation (SPEC §8). The
 * model list refreshes on connect, after load(), and after a completed chat
 * exchange.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createClient } from "../api/client";
import type {
  ChatMessage,
  KeepAlive,
  Model,
  ModelGroup,
  OllamaClient,
  RunOptions,
  RunningModel,
  ServerStatus,
  ThinkLevel,
} from "../api/types";
import { RUN_OPTION_KEYS } from "../api/types";
import {
  createSession,
  loadSessions,
  newMessageId,
  saveSessions,
  sortSessions,
  titleFor,
  type ChatSession,
  type Lane,
  type LaneConfig,
  type Message,
} from "../chat/sessions";
// T2 — A/B compare (docs/SPEC-tuning.md). The pure parts live next door in
// chat/compare.ts; this file owns only the run itself.
import {
  LANES,
  effectiveLaneOptions,
  historyForLane,
  laneConfig,
  neitherLaneSetsSeed,
  randomSeed,
  withLane,
} from "../chat/compare";
// M3 — owned by a concurrent agent (app/src/modelfile/). Consumed here, not
// redeclared: parseModelfile/serializeModelfile plus toCreateRequest are the
// editor's sync contract with the raw Modelfile (SPEC.md §5.4).
import {
  parseModelfile,
  serializeModelfile,
  setParameter,
  setSystem,
  type ModelfileDoc,
} from "../modelfile";
import { toCreateRequest } from "../modelfile/createRequest";
// T1 — Modelfile history (docs/SPEC-tuning.md). The ring buffer and its
// persistence live in editor/history.ts; this file owns the save path that
// feeds it and the restore that reads it back into a draft.
import {
  appendSnapshot,
  loadHistory,
  newSnapshotId,
  saveHistory,
  snapshotsForTag,
  type ModelfileSnapshot,
} from "../editor/history";

export type View = "chat" | "modelfile" | "tools" | "pull" | "settings";

/** Settings persisted across restarts (SPEC §5.6), separate from chat sessions. */
const SETTINGS_STORAGE_KEY = "remuda.settings.v1";

interface PersistedSettings {
  /** "Confirm before deleting a model" (SPEC §5.6, §8): also gates Save-over-existing. */
  confirmDeleteModel: boolean;
}

const DEFAULT_SETTINGS: PersistedSettings = { confirmDeleteModel: true };

function loadSettings(): PersistedSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SETTINGS;
    const value = (parsed as Record<string, unknown>).confirmDeleteModel;
    return { confirmDeleteModel: typeof value === "boolean" ? value : DEFAULT_SETTINGS.confirmDeleteModel };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: PersistedSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota/private-mode failures: the setting simply won't survive a restart.
  }
}

/**
 * The Modelfile editor's working copy (SPEC.md §5.4, §8).
 *
 * `doc` is the current (possibly unsaved) state; `savedDoc` is what was last
 * loaded/saved, used by Revert. `targetTag` is the model Save overwrites —
 * null for a brand-new Modelfile opened from "+ New Modelfile", which has no
 * target until Save as… names one.
 */
export interface EditorDraft {
  targetTag: string | null;
  doc: ModelfileDoc;
  savedDoc: ModelfileDoc;
  dirty: boolean;
  /**
   * Bumped whenever `doc` is replaced from *outside* the editor's own panes
   * — Restore (T1) and "promote to system prompt". The raw pane resyncs on
   * `savedDoc`'s identity so ordinary typing is never clobbered, and those
   * two paths deliberately leave `savedDoc` alone (Revert must still go back
   * to the last saved text), so they need their own resync signal.
   */
  externalEdit?: number;
  /**
   * The snapshot this draft was restored from, if any. The Save that follows
   * a Restore records its snapshot as kind "restore" and parents it here
   * (SPEC-tuning T1). Cleared whenever a fresh draft is loaded or saved.
   */
  restoredFromId?: string | null;
}

/** Which pane the Modelfile editor is showing (SPEC-tuning T1). */
export type EditorPane = "form" | "raw" | "history";

export type ReloadPhase = "creating" | "stopping" | "reloading" | "done";

/** The bottom-center "stop & reload" toast state (SPEC §5.4). */
export interface ReloadToastState {
  phase: ReloadPhase;
  oldTag: string | null;
  newTag: string;
  /** Latest streamed status line from `ollama create`, if any. */
  detail?: string;
}

/** The model currently loaded in Ollama (SPEC §5.1): its base and effective tag. */
export interface LoadedSelection {
  base: string;
  variant: string;
}

/**
 * Timings of the last completed reply, tied to its session.
 *
 * `sessionId` and `tokPerSec` are the original contract and stay exactly as
 * they were — ChatView renders `tokPerSec` today. Everything after them comes
 * from the newer `done` fields, which not every server sends: null means "the
 * server didn't say", never zero.
 */
export interface LastStats {
  sessionId: string;
  /**
   * The assistant message these timings belong to.
   *
   * Optional and additive: `sessionId` alone identifies the reply while only
   * one generation runs per session, which is still the policy (SPEC §8), so
   * StatsStrip keeps reading exactly what it reads today. Two lanes in one
   * session would collide on `sessionId`, and this is what will tell them
   * apart (SPEC-tuning T2).
   */
  messageId?: string;
  /** Generation throughput, tok/s (eval_count ÷ eval_duration). */
  tokPerSec: number;
  /** Tokens generated. */
  evalCount: number;
  /** Prefill throughput, tok/s; null when the server omits prompt timings. */
  promptTokPerSec: number | null;
  /** Prompt tokens evaluated; null when the server omits it. */
  promptEvalCount: number | null;
  /** Context used = prompt + generated tokens; null without a prompt count. */
  contextTokens: number | null;
  /** Time spent loading the model, ms; null when the server omits it. */
  loadMs: number | null;
  /** Wall time for the whole request, ms; null when the server omits it. */
  totalMs: number | null;
}

/** The A/B run in flight: one session, one lane at a time (SPEC-tuning T2). */
export interface CompareRun {
  sessionId: string;
  /** The lane currently generating. The other is queued, or already done. */
  lane: Lane;
}

/**
 * One generation's whole input (SPEC-tuning T2).
 *
 * Deliberately closed over nothing: the model, the outbound history, the
 * options and the reply's destination are all arguments, because A/B runs
 * two of these with the same session and different everything else.
 */
export interface RunGenerationArgs {
  sessionId: string;
  /** The assistant message this run streams into; it must already exist. */
  targetMessageId: string;
  /** Effective tag to run — not necessarily the session's own. */
  model: string;
  /** Outbound history, already mapped for the wire (no `id`, no `thinking`). */
  messages: ChatMessage[];
  options?: RunOptions;
  think?: ThinkLevel;
  /**
   * Cancels this run. A/B passes one signal to both lanes so a single
   * Cancel stops the pair; the stream map still tracks each lane on its own.
   */
  signal: AbortSignal;
}

export interface RemudaContextValue {
  client: OllamaClient;
  /** Latest health check result. */
  status: ServerStatus;
  /** True once the first health check has resolved (success or failure). */
  checked: boolean;
  models: Model[];
  groups: ModelGroup[];
  /**
   * The full GET /api/ps readout — size, VRAM split, context, keep_alive
   * expiry (SPEC §5.1). Refreshed by the same health/sync poll that already
   * reads /api/ps for `isLoaded`; no extra request, no second timer.
   */
  running: RunningModel[];
  /**
   * Every model resident in Ollama right now, in model-list order. Empty
   * when nothing is loaded — there is no singular "the loaded model" any
   * more, only what memory happens to be holding.
   */
  loaded: LoadedSelection[];
  /**
   * Which resident model an action gets when the user hasn't named one
   * (New chat, the Modelfile tab). Null when nothing is loaded.
   */
  activeModel: LoadedSelection | null;
  keepAlive: KeepAlive;
  setKeepAlive: (keepAlive: KeepAlive) => void;
  /** "Confirm before deleting a model" (SPEC §5.6): persisted, default on. */
  confirmDeleteModel: boolean;
  setConfirmDeleteModel: (value: boolean) => void;
  view: View;
  setView: (view: View) => void;
  loadPaneOpen: boolean;
  openLoadPane: () => void;
  closeLoadPane: () => void;
  /** Re-fetch the installed model list. */
  refreshModels: () => Promise<void>;
  /** Load a model with the configured keep_alive, then refresh the model list. */
  load: (tag: string, numCtx?: number) => Promise<void>;
  /** Free one model's weights (keep_alive: 0), then refresh the list. */
  unload: (tag: string) => Promise<void>;
  /** Free every resident model, then refresh the list once. */
  unloadAll: () => Promise<void>;
  /**
   * Pin a resident model against its keep_alive expiry, or hand it back to
   * the configured one. Re-sends the load — Ollama has no other way to
   * restate keep_alive for weights already in memory.
   */
  setKept: (tag: string, kept: boolean) => Promise<void>;
  /** Re-run the health check immediately (e.g. Retry on the offline banner). */
  checkHealth: () => Promise<void>;

  // ---- chat (SPEC §5.2, §5.3, §6, §8) ----
  /** Saved sessions, most-recent first. Persisted to localStorage. */
  sessions: ChatSession[];
  activeSessionId: string | null;
  /** The session a generation is streaming into; null when idle (SPEC §8). */
  streamingSessionId: string | null;
  /** Non-abort failure from the last generation, if any. */
  streamError: string | null;
  /**
   * Errors keyed by the assistant message they belong to. `streamError` is a
   * single app-wide slot, which two lanes cannot share: lane B starting would
   * otherwise erase the error lane A just produced, leaving an empty bubble
   * and no explanation anywhere on screen.
   */
  errorsByMessage: Record<string, string>;
  /** Timings of the last completed reply, tied to its session. */
  lastStats: LastStats | null;
  /**
   * Every reply's timings, by message id (SPEC-tuning T2).
   *
   * `lastStats` is one record and cannot hold two lanes at once — and the
   * whole point of A/B is that both sets of numbers are on screen together,
   * in the same grid positions. This is the addressable form; `lastStats`
   * keeps its exact meaning for the single-lane path.
   *
   * In memory only. Timings describe a run, not a transcript, so they are no
   * more restorable than the run was.
   */
  statsByMessage: Record<string, LastStats>;
  /**
   * The A/B run in flight: which session, and which lane is generating
   * *right now*. Null when no compare run is going.
   *
   * Lanes are sequential (SPEC §8), so this is one lane, never two. It is
   * also the guard: `streamsRef` is empty in the gap between lane A ending
   * and lane B starting, and without this a send in that gap would interleave
   * a third generation into the pair.
   */
  compareRun: CompareRun | null;
  /** New session on the currently loaded model; no-op when nothing is loaded. */
  newChat: () => void;
  openSession: (id: string) => void;
  deleteSession: (id: string) => void;
  /**
   * Append the user message and stream the assistant reply (SPEC §5.3).
   * `images` are raw base64 for the wire; `imageThumbs` are the small data:
   * URLs that get persisted in their place.
   */
  sendMessage: (text: string, images?: string[], imageThumbs?: string[]) => Promise<void>;
  /**
   * Stream one generation into one named assistant message (SPEC-tuning T2).
   *
   * The seam under `sendMessage`: everything it needs arrives in `args`, so
   * nothing about *which* session is active, or which options that session
   * holds, is read from the closure. A second lane is then two calls with
   * two `targetMessageId`s and two `options` bags, sharing one `signal`.
   *
   * Not reachable from any UI yet — `sendMessage` is still the only caller,
   * and the one-at-a-time guard (SPEC §8) is unchanged.
   */
  runGeneration: (args: RunGenerationArgs) => Promise<void>;
  /** Per-session sampling overrides, sent on every request for that session. */
  setSessionOptions: (sessionId: string, options: RunOptions) => void;
  /** Per-session reasoning effort; "off" omits `think` from the request. */
  setSessionThink: (sessionId: string, level: ThinkLevel) => void;

  // ---- A/B compare (docs/SPEC-tuning.md T2) ----
  /**
   * Turn compare mode on or off for a session.
   *
   * Switching on seeds both lanes from the configuration the chat is already
   * running — the question is always "is this change better than what I have",
   * so lane A starts as *what I have*. Switching off keeps the transcript as
   * it is; only `Keep this side` discards a lane.
   */
  toggleCompare: (sessionId: string) => void;
  /**
   * Replace one lane's model / overrides / think, leaving the other alone.
   *
   * Setting a lane's own `seed` unpins the pair: a per-lane seed is a
   * deliberate difference between the lanes, and silently overriding it with
   * the pin would make the run ignore what the user just typed.
   */
  setLaneConfig: (sessionId: string, lane: Lane, patch: Partial<LaneConfig>) => void;
  /** Pin a shared seed for the pair, or unpin (null) and let each lane speak. */
  setPinnedSeed: (sessionId: string, seed: number | null) => void;
  /**
   * Send one prompt to both lanes (SPEC-tuning T2).
   *
   * The user message is appended **once, with no lane**; each lane gets its
   * own assistant message. Lane A runs to completion, *then* lane B — two
   * concurrent generations would contend for the same VRAM and the tok/s
   * under each lane would be measuring the contention, not the configuration.
   */
  sendCompare: (text: string, images?: string[], imageThumbs?: string[]) => Promise<void>;
  /**
   * Collapse the comparison onto one lane: the session adopts that lane's
   * model, overrides and think, the other lane's replies are discarded, and
   * compare mode ends. This is the decision the feature exists to serve, so
   * it is one button rather than a sequence of steps.
   */
  keepLane: (sessionId: string, lane: Lane) => void;
  /**
   * Re-roll one assistant reply in place (SPEC-tuning T6, item 3).
   *
   * `seed` undefined holds whatever the configuration names — re-rolling the
   * *config*; a number re-rolls the *sampling*. That distinction is the whole
   * reason there are two menu items and not one. The seed is not written back
   * into the session: a re-roll should not quietly rewrite the chat's saved
   * run options.
   */
  regenerateReply: (sessionId: string, messageId: string, seed?: number) => Promise<void>;
  /**
   * "Bake into Modelfile" (SPEC §5.3): open `tag`'s Modelfile in the editor
   * with the chat's per-session overrides written in as PARAMETER lines.
   *
   * It opens the editor itself rather than switching to it, because a
   * chat-only user has no draft — navigating to the Modelfile view without
   * one lands on an empty placeholder, which is where the values would have
   * been silently dropped. Nothing is saved: the draft is dirty and the user
   * still presses Save or Save as… deliberately (SPEC §5.4).
   */
  bakeOptionsIntoEditor: (tag: string, options: RunOptions) => Promise<void>;
  /** Abort the in-flight generation, keeping the partial reply. */
  cancelGeneration: () => void;

  // ---- Modelfile editor (SPEC §5.4, §8) ----
  editorDraft: EditorDraft | null;
  /** True while openEditor's client.show() fetch is in flight. */
  editorLoading: boolean;
  /** Non-null when openEditor's fetch failed. */
  editorError: string | null;
  /** Fetch and parse an existing model's Modelfile, then switch to it. */
  openEditor: (tag: string) => Promise<void>;
  /** Seed a new Modelfile (FROM baseTag) with no save target yet. */
  openEditorForNew: (baseTag: string) => void;
  /** Replace the draft's doc (a form or raw-text edit); marks dirty. */
  setEditorDoc: (doc: ModelfileDoc) => void;
  /** Discard unsaved edits back to the last-loaded/-saved doc. */
  revertEditor: () => void;
  /** True while a save (create → unload → load) is in flight. */
  saving: boolean;
  /** Verbatim error from a failed `ollama create` (SPEC §9); editor stays dirty. */
  saveError: string | null;
  /** The stop & reload toast's current state; null when not saving. */
  reloadToast: ReloadToastState | null;
  /**
   * Save flow (SPEC §5.4): `ollama create` → stop the previously loaded
   * model → warm-load the new one → refresh the model list. `asName` makes
   * this "Save as…" (a new tuned variant); omitted, it overwrites
   * `editorDraft.targetTag`. `quantize` (e.g. "q4_K_M") asks Ollama to
   * quantise on the way in; omitted, the weights are copied as-is.
   */
  saveDraft: (asName?: string, quantize?: string) => Promise<void>;

  // ---- Modelfile history (SPEC-tuning.md T1) ----
  /**
   * Every persisted snapshot, all tags, newest first. A successful Save or
   * Save as… appends one; nothing else writes here, and a *failed* create
   * writes nothing at all.
   */
  modelfileHistory: ModelfileSnapshot[];
  /** One tag's ring, newest first. */
  historyForTag: (tag: string | null) => ModelfileSnapshot[];
  /** Which pane the editor shows: Form, Raw or History. */
  editorPane: EditorPane;
  setEditorPane: (pane: EditorPane) => void;
  /**
   * "Restore this" (SPEC-tuning T1): load a snapshot into the editor as an
   * UNSAVED draft and switch to Raw.
   *
   * It does not run `ollama create`, does not unload or reload the model,
   * and does not write a snapshot of its own. The user still presses Save,
   * which goes through the normal confirm (SPEC §8) and records a snapshot
   * of kind "restore". A history feature that silently rebuilds a model on
   * click is a trap, not a safety net.
   */
  restoreSnapshot: (id: string) => void;
  /**
   * Stage `text` into the active model's SYSTEM instruction and open the
   * Modelfile editor on it, dirty and unsaved (SPEC-tuning T6). Nothing is
   * created and nothing is saved; no-op when no model is loaded.
   */
  promoteToSystem: (text: string) => Promise<void>;
}

const RemudaContext = createContext<RemudaContextValue | null>(null);

/**
 * Identity of the installed set: which tags exist and when each was last
 * written. `modifiedAt` is what makes a re-pull of the same tag visible —
 * the name alone wouldn't change.
 */
function signatureOf(models: Model[]): string {
  return models
    .map((m) => `${m.tag}@${m.modifiedAt}`)
    .sort()
    .join("\n");
}

function signatureOfGroups(groups: ModelGroup[]): string {
  return signatureOf(groups.flatMap((g) => [g.base, ...g.variants]));
}

/**
 * Field-wise equality for the /api/ps readout. The poll re-parses it every
 * 5s into fresh objects; without this every consumer of `running` would
 * re-render twice a minute to be handed identical numbers.
 */
function sameRunning(a: RunningModel[], b: RunningModel[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const other = b[i];
    return (
      m.tag === other.tag &&
      m.sizeBytes === other.sizeBytes &&
      m.sizeVramBytes === other.sizeVramBytes &&
      m.contextLength === other.contextLength &&
      m.expiresAt === other.expiresAt
    );
  });
}

/**
 * A stored message as the model should see it.
 *
 * `thinking` is dropped: Ollama does not take reasoning back as context, and
 * feeding an assistant's scratchpad in as history corrupts the conversation.
 * `imageThumbs` goes too — it's the persisted display copy, not input; the
 * raw base64 in `images` is what the wire wants. `id` is Remuda's own
 * routing handle and has no meaning on the wire at all.
 */
function forWire(message: Message): ChatMessage {
  if (
    message.id === undefined &&
    message.thinking === undefined &&
    message.imageThumbs === undefined
  ) {
    return message;
  }
  const { id: _id, thinking: _thinking, imageThumbs: _thumbs, ...rest } = message;
  return rest;
}

/** ns → whole ms, for the timings ChatView renders. */
function toMs(ns: number | undefined): number | null {
  return typeof ns === "number" ? Math.round(ns / 1e6) : null;
}

/**
 * Every model Ollama currently holds in memory, not just the first.
 *
 * Ollama keeps up to OLLAMA_MAX_LOADED_MODELS resident at once and /api/ps
 * reports all of them; taking `.find()` here was the single line that made
 * the rest of the app believe in one. Order follows the grouped model list
 * rather than /api/ps, which reshuffles as models come and go — a tray that
 * reorders itself under the cursor is worse than one that doesn't.
 */
function deriveLoaded(models: Model[]): LoadedSelection[] {
  return models
    .filter((m) => m.isLoaded)
    .map((m) => (m.isVariant && m.base ? { base: m.base, variant: m.tag } : { base: m.tag, variant: m.tag }));
}

/**
 * The resident model an app-wide action should act on when the user hasn't
 * pointed at one: New chat, the Modelfile tab, the reload half of Save.
 *
 * The active chat's own model wins when it's resident — that is the model
 * the user is demonstrably working with. Otherwise the first resident one,
 * which is what the whole app used to mean by "loaded".
 */
function deriveActiveModel(loaded: LoadedSelection[], sessionModel: string | undefined): LoadedSelection | null {
  const bound = sessionModel !== undefined ? loaded.find((l) => l.variant === sessionModel) : undefined;
  return bound ?? loaded[0] ?? null;
}

export interface RemudaProviderProps {
  children: ReactNode;
  /** Injected for tests; defaults to the real Ollama client. */
  client?: OllamaClient;
  /** Health-check poll interval; overridable for tests. */
  pollIntervalMs?: number;
}

export function RemudaProvider({
  children,
  client: injectedClient,
  pollIntervalMs = 5000,
}: RemudaProviderProps) {
  const client = useMemo(() => injectedClient ?? createClient(), [injectedClient]);
  const [status, setStatus] = useState<ServerStatus>({ connected: false, version: null });
  const [checked, setChecked] = useState(false);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [running, setRunning] = useState<RunningModel[]>([]);
  const [keepAlive, setKeepAlive] = useState<KeepAlive>("5m");
  // Read at call time by setKept, which must not re-identify whenever the
  // Settings keep-alive changes.
  const keepAliveRef = useRef<KeepAlive>(keepAlive);
  keepAliveRef.current = keepAlive;
  const [confirmDeleteModel, setConfirmDeleteModelState] = useState<boolean>(
    () => loadSettings().confirmDeleteModel,
  );
  const setConfirmDeleteModel = useCallback((value: boolean) => {
    setConfirmDeleteModelState(value);
    saveSettings({ confirmDeleteModel: value });
  }, []);
  const [view, setViewState] = useState<View>("chat");
  // Callbacks declared before setView (newChat/openSession) also need the
  // current view without taking it as a dep; a ref avoids both the TDZ and
  // the churn.
  const viewRef = useRef<View>("chat");
  viewRef.current = view;
  const [loadPaneOpen, setLoadPaneOpen] = useState(false);
  const wasConnected = useRef(false);
  /** Last observed installed-set signature; null forces a full rebuild. */
  const installedSignature = useRef<string | null>(null);
  /** Guards against a second /api/show sweep starting before the first ends. */
  const sweepInFlight = useRef(false);

  const [editorDraft, setEditorDraft] = useState<EditorDraft | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadToast, setReloadToast] = useState<ReloadToastState | null>(null);
  const editorDraftRef = useRef<EditorDraft | null>(null);
  editorDraftRef.current = editorDraft;

  // T1 — Modelfile history. Loaded once from localStorage; written only by
  // the save path below, which is the single funnel every Modelfile write
  // already goes through (SPEC-tuning T1).
  const [modelfileHistory, setModelfileHistory] = useState<ModelfileSnapshot[]>(() => loadHistory());
  const historyRef = useRef(modelfileHistory);
  historyRef.current = modelfileHistory;
  const [editorPane, setEditorPane] = useState<EditorPane>("form");

  /** SPEC §8: unsaved editor changes prompt before navigating away. */
  const confirmUnsavedChanges = useCallback((): boolean => {
    if (!editorDraftRef.current?.dirty) return true;
    return window.confirm("Discard unsaved Modelfile changes?");
  }, []);

  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [errorsByMessage, setErrorsByMessage] = useState<Record<string, string>>({});
  const [lastStats, setLastStats] = useState<LastStats | null>(null);
  /** Timings by message id — two lanes can't share one `lastStats` slot (T2). */
  const [statsByMessage, setStatsByMessage] = useState<Record<string, LastStats>>({});
  const [compareRun, setCompareRun] = useState<CompareRun | null>(null);
  /**
   * The pair-wide controller of an A/B run, and the guard that keeps a compare
   * run indivisible.
   *
   * Lanes are sequential, so `streamsRef` goes empty between them. Without
   * this ref that gap is a hole in SPEC §8's one-at-a-time rule: a send
   * landing in it would start a third generation beside a run that is only
   * half finished. The relaxation is exactly one run wide — a compare run is
   * still one generation at a time.
   */
  const compareRunRef = useRef<{ controller: AbortController; sessionId: string } | null>(null);
  /**
   * Every in-flight generation, keyed by the assistant message it streams
   * into; also the synchronous one-at-a-time guard (SPEC §8).
   *
   * A map rather than a slot because "the stream that just ended" and "the
   * stream still running" have to be distinguishable — a single slot cleared
   * in a `finally` cannot tell them apart. The §8 policy is unchanged: the
   * guard in `sendMessage` still refuses a send while the map is non-empty.
   */
  const streamsRef = useRef<Map<string, { controller: AbortController; sessionId: string }>>(
    new Map(),
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Coalesce writes: a streaming reply updates `sessions` per token, and a
  // stringify+setItem of the whole list per token is wasted work. Trailing
  // 300ms debounce — the timer set by the last change always fires, so the
  // final state is always persisted.
  useEffect(() => {
    const id = window.setTimeout(() => saveSessions(sessions), 300);
    return () => window.clearTimeout(id);
  }, [sessions]);
  // The debounce's blind spot: closing the window inside the 300ms window
  // would drop the tail. Flush synchronously on the way out (and on
  // provider unmount) so what the user last saw is what restores.
  useEffect(() => {
    const flush = () => saveSessions(sessionsRef.current);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, []);

  const applyRunning = useCallback((next: RunningModel[]) => {
    setRunning((prev) => (sameRunning(prev, next) ? prev : next));
  }, []);

  const refreshModels = useCallback(async () => {
    // listGroups() reduces /api/ps to isLoaded and drops the rest, so the
    // runtime numbers need their own read here. This runs on explicit acts
    // only — Load, Eject, a completed pull, a save — never on a poll tick,
    // which gets both out of one listModelsWithRunning() call below.
    const [list, live] = await Promise.all([client.listGroups(), client.listRunning()]);
    setGroups(list);
    applyRunning(live);
    installedSignature.current = signatureOfGroups(list);
  }, [client, applyRunning]);

  /**
   * Cheap reconcile against the server: /api/tags + /api/ps only.
   *
   * Two jobs. Ollama loads on demand, so `isLoaded` drifts constantly and is
   * remapped onto the groups we already have — structural facts (bases,
   * variants, context length) can't change from merely chatting.
   *
   * But the *set* of installed models can change without Remuda doing
   * anything: `ollama pull` or `ollama rm` in a terminal, or another client.
   * Comparing the tag+modifiedAt signature catches that, and only then do we
   * pay for the full listGroups sweep (one /api/show per model). Without
   * this, a model pulled outside Remuda stayed invisible until the
   * connection dropped and came back.
   */
  const syncModels = useCallback(async () => {
    // listModelsWithRunning is listModels' two requests, keeping the /api/ps
    // body instead of throwing it away — the runtime readout is free here.
    const { models: list, running: live } = await client.listModelsWithRunning();
    applyRunning(live);
    const signature = signatureOf(list);
    if (signature !== installedSignature.current) {
      // The poll doesn't wait for us, so a sweep slower than the interval
      // would otherwise have the next tick launch another one on top.
      if (sweepInFlight.current) return;
      sweepInFlight.current = true;
      // Claim the signature *before* sweeping, not after. If listGroups
      // rejects — one bad /api/show is enough — an unclaimed signature would
      // mismatch again on every subsequent tick and re-launch the sweep
      // forever, silently. Claiming it costs a stale list until the next
      // real change (or a reconnect, which clears the signature) and buys a
      // hard guarantee of at most one sweep per change.
      installedSignature.current = signature;
      try {
        await refreshModels();
      } finally {
        sweepInFlight.current = false;
      }
      return;
    }
    const loadedTags = new Set(list.filter((m) => m.isLoaded).map((m) => m.tag));
    setGroups((prev) => {
      // This runs on every poll tick. Returning `prev` unchanged when nothing
      // actually loaded or unloaded lets React bail out, instead of handing
      // every consumer fresh object identities twice a minute.
      const changed = prev.some(
        (g) =>
          g.base.isLoaded !== loadedTags.has(g.base.tag) ||
          g.variants.some((v) => v.isLoaded !== loadedTags.has(v.tag)),
      );
      if (!changed) return prev;
      return prev.map((g) => ({
        base: { ...g.base, isLoaded: loadedTags.has(g.base.tag) },
        variants: g.variants.map((v) => ({ ...v, isLoaded: loadedTags.has(v.tag) })),
      }));
    });
  }, [client, refreshModels, applyRunning]);

  const checkHealth = useCallback(async () => {
    try {
      const s = await client.version();
      setStatus(s);
      setChecked(true);
      if (s.connected) {
        if (!wasConnected.current) {
          // (Re)connected: drop the signature so the sync below rebuilds the
          // groups from scratch rather than trusting a pre-outage snapshot.
          wasConnected.current = true;
          installedSignature.current = null;
        }
        await syncModels().catch(() => {});
      } else {
        wasConnected.current = false;
        installedSignature.current = null;
        // Unreachable server: we no longer know what's resident, and a stale
        // list would read as fact. Say nothing rather than something wrong.
        applyRunning([]);
      }
    } catch {
      setStatus({ connected: false, version: null });
      setChecked(true);
      wasConnected.current = false;
      installedSignature.current = null;
      applyRunning([]);
    }
  }, [client, syncModels, applyRunning]);

  useEffect(() => {
    void checkHealth();
    const id = window.setInterval(() => {
      void checkHealth();
    }, pollIntervalMs);
    return () => window.clearInterval(id);
  }, [checkHealth, pollIntervalMs]);

  const load = useCallback(
    async (tag: string, numCtx?: number) => {
      await client.load(tag, keepAlive, undefined, numCtx);
      await refreshModels();
    },
    [client, keepAlive, refreshModels],
  );

  const models = useMemo(
    () => groups.flatMap((g) => [g.base, ...g.variants]),
    [groups],
  );
  const loaded = useMemo(() => deriveLoaded(models), [models]);
  const activeSessionModel = sessions.find((s) => s.id === activeSessionId)?.model;
  const activeModel = useMemo(
    () => deriveActiveModel(loaded, activeSessionModel),
    [loaded, activeSessionModel],
  );
  // Same reason as viewRef above: these change on every poll tick and on
  // every session switch, and the callbacks below would otherwise hand every
  // consumer a fresh identity twice a minute for a value they only read at
  // call time.
  const loadedRef = useRef<LoadedSelection[]>(loaded);
  loadedRef.current = loaded;
  const modelsRef = useRef<Model[]>(models);
  modelsRef.current = models;
  const activeModelRef = useRef<LoadedSelection | null>(activeModel);
  activeModelRef.current = activeModel;

  /**
   * Eject one model (SPEC §7: `/api/generate` with `keep_alive: 0`).
   *
   * Not a mode — Ollama re-loads on demand, so this only hands the weights'
   * memory back; the next chat or Load warms them again. Rejections
   * propagate to the caller, which owns the error surface (LoadPane).
   */
  const unload = useCallback(
    async (tag: string) => {
      await client.unload(tag);
      await refreshModels();
    },
    [client, refreshModels],
  );

  /**
   * Eject everything. The unloads go out together — they're independent
   * calls against one server — but the list is refreshed once, at the end,
   * so the tray empties in a single step instead of shedding rows.
   */
  const unloadAll = useCallback(async () => {
    const tags = loadedRef.current.map((l) => l.variant);
    if (tags.length === 0) return;
    try {
      await Promise.all(tags.map((tag) => client.unload(tag)));
    } finally {
      await refreshModels();
    }
  }, [client, refreshModels]);

  /**
   * Pin a model in memory, or let it expire again.
   *
   * `keep_alive: -1` is Ollama's "never unload", and the only way to restate
   * it for resident weights is to re-send the load — which is cheap when the
   * model is already there, since nothing is re-read from disk.
   */
  const setKept = useCallback(
    async (tag: string, kept: boolean) => {
      await client.load(tag, kept ? -1 : keepAliveRef.current);
      await refreshModels();
    },
    [client, refreshModels],
  );

  /** Apply fn to one session and keep the list sorted most-recent first. */
  const updateSession = useCallback((id: string, fn: (s: ChatSession) => ChatSession) => {
    setSessions((prev) => sortSessions(prev.map((s) => (s.id === id ? fn(s) : s))));
  }, []);

  const newChat = useCallback(() => {
    // §5.2: New chat opens on a *resident* model — nothing loaded, nothing
    // to bind the session to. With several resident it takes activeModel,
    // which prefers the model the current chat already talks to.
    if (!activeModel) return;
    // The sidebar stays visible while the Modelfile editor is open, so this
    // is a navigation away from it — same unsaved-changes gate as setView
    // (SPEC §8), not a silent discard.
    if (viewRef.current === "modelfile" && !confirmUnsavedChanges()) return;
    const session = createSession(activeModel.variant);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setStreamError(null);
    setViewState("chat");
  }, [activeModel, confirmUnsavedChanges]);

  const openSession = useCallback((id: string) => {
    if (viewRef.current === "modelfile" && !confirmUnsavedChanges()) return;
    setActiveSessionId(id);
    // A previous session's failure isn't this one's (it renders globally).
    setStreamError(null);
    setViewState("chat");
  }, [confirmUnsavedChanges]);

  /**
   * Mirror the stream map into observable state.
   *
   * `streamingSessionId` keeps its exact meaning — the session a generation
   * is streaming into, null when idle — it is just no longer set and cleared
   * by hand at the two ends of one function. Insertion order makes the first
   * entry the oldest run, which under the §8 one-at-a-time policy is also
   * the only one.
   */
  const syncStreamingSessionId = useCallback(() => {
    const first = streamsRef.current.values().next();
    setStreamingSessionId(first.done === true ? null : first.value.sessionId);
  }, []);

  const deleteSession = useCallback((id: string) => {
    // Only this session's runs. Aborting the map wholesale would take down a
    // generation the user never asked to stop.
    for (const entry of streamsRef.current.values()) {
      if (entry.sessionId === id) entry.controller.abort();
    }
    if (compareRunRef.current?.sessionId === id) {
      compareRunRef.current.controller.abort();
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveSessionId((prev) => (prev === id ? null : prev));
    setLastStats((prev) => (prev?.sessionId === id ? null : prev));
    setStatsByMessage((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([, stats]) => stats.sessionId !== id),
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, []);

  /** Stop everything in flight (SPEC §5.3). Partial replies are kept. */
  const cancelGeneration = useCallback(() => {
    // The pair first: aborting only the streaming lane would let the queued
    // one start on a run the user just cancelled. Cancel cancels both lanes
    // and keeps whatever streamed (SPEC-tuning T2).
    compareRunRef.current?.controller.abort();
    for (const entry of streamsRef.current.values()) {
      entry.controller.abort();
    }
  }, []);

  /**
   * Stream one reply into one named message (SPEC-tuning T2).
   *
   * Reads nothing from the closure that identifies the run: not
   * `activeSessionId`, not `session.options`, not `session.think`. That is
   * the whole point of the extraction — A/B is two calls with two targets
   * and two option bags, and a helper that reached for "the active session"
   * could not express that.
   *
   * The target must already exist in the session. A missing id is a no-op,
   * never a write to the last message: appending to whatever happens to be
   * at the end is exactly the bug this replaces.
   */
  const runGeneration = useCallback(
    async ({
      sessionId,
      targetMessageId,
      model,
      messages,
      options,
      think,
      signal,
    }: RunGenerationArgs) => {
      // Own controller, chained to the caller's signal. The caller's signal
      // may be shared across a pair of lanes, so aborting *this* run has to
      // be possible without stopping the other one; abort still propagates
      // inwards from the pair-wide signal.
      const controller = new AbortController();
      const forward = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forward, { once: true });

      // Read before this run is registered: a sibling lane already in flight
      // means the app-wide slot is not ours to clear.
      const isOnlyRun = streamsRef.current.size === 0;
      streamsRef.current.set(targetMessageId, { controller, sessionId });
      syncStreamingSessionId();
      if (isOnlyRun) setStreamError(null);
      setErrorsByMessage((prev) => {
        if (!(targetMessageId in prev)) return prev;
        const next = { ...prev };
        delete next[targetMessageId];
        return next;
      });

      try {
        for await (const chunk of client.chat(model, messages, {
          keepAlive,
          signal: controller.signal,
          think,
          options,
        })) {
          const thinking = chunk.thinking ?? "";
          if (chunk.content !== "" || thinking !== "") {
            updateSession(sessionId, (s) => {
              const index = s.messages.findIndex((m) => m.id === targetMessageId);
              if (index === -1) return s;
              const target = s.messages[index];
              if (target.role !== "assistant") return s;
              const next: Message = { ...target };
              if (chunk.content !== "") {
                next.content = target.content + chunk.content;
              }
              // Reasoning accumulates in its own field — never into content.
              if (thinking !== "") {
                next.thinking = (target.thinking ?? "") + thinking;
              }
              const nextMessages = [...s.messages];
              nextMessages[index] = next;
              return { ...s, messages: nextMessages };
            });
          }
          if (chunk.done && chunk.stats && chunk.stats.evalDurationNs > 0) {
            const stats = chunk.stats;
            const promptEvalCount = stats.promptEvalCount ?? null;
            const promptEvalDurationNs = stats.promptEvalDurationNs;
            const record: LastStats = {
              sessionId,
              messageId: targetMessageId,
              tokPerSec: Math.round(stats.evalCount / (stats.evalDurationNs / 1e9)),
              evalCount: stats.evalCount,
              promptTokPerSec:
                promptEvalCount !== null &&
                promptEvalDurationNs !== undefined &&
                promptEvalDurationNs > 0
                  ? Math.round(promptEvalCount / (promptEvalDurationNs / 1e9))
                  : null,
              promptEvalCount,
              // What the runner actually held this turn: prompt + reply.
              contextTokens: promptEvalCount === null ? null : promptEvalCount + stats.evalCount,
              loadMs: toMs(stats.loadDurationNs),
              totalMs: toMs(stats.totalDurationNs),
            };
            setLastStats(record);
            // Addressable copy: A/B needs both lanes' numbers on screen at
            // once, and `lastStats` is one slot.
            setStatsByMessage((prev) => ({ ...prev, [targetMessageId]: record }));
          }
        }
        // Completed exchange: bump updatedAt (§6) and re-check /api/ps —
        // Ollama loads on demand, so the session's model may be loaded now.
        updateSession(sessionId, (s) => ({ ...s, updatedAt: new Date().toISOString() }));
        void syncModels().catch(() => {});
      } catch (err) {
        // Cancel keeps the partial reply and isn't an error (SPEC §5.3).
        const aborted =
          controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
        if (!aborted) {
          const message = err instanceof Error ? err.message : String(err);
          setStreamError(message);
          // Addressable copy, so a lane can show its own failure even after a
          // sibling lane clears or overwrites the app-wide slot.
          setErrorsByMessage((prev) => ({ ...prev, [targetMessageId]: message }));
        }
      } finally {
        signal.removeEventListener("abort", forward);
        // Only this run's entry. Clearing the map would strand a sibling
        // lane that is still streaming — the single-slot bug, re-made.
        streamsRef.current.delete(targetMessageId);
        syncStreamingSessionId();
      }
    },
    [client, keepAlive, syncModels, syncStreamingSessionId, updateSession],
  );

  const sendMessage = useCallback(
    async (text: string, images?: string[], imageThumbs?: string[]) => {
      const trimmed = text.trim();
      const sessionId = activeSessionId;
      // An attachment is content in its own right: "what is this?" is often
      // just the picture. Empty text with no images is still a no-op.
      const hasImages = images !== undefined && images.length > 0;
      // One streamed generation at a time, app-wide (SPEC §8). The map makes
      // more than one *possible*; this guard is what still says no.
      if (
        (trimmed === "" && !hasImages) ||
        sessionId === null ||
        streamsRef.current.size > 0 ||
        compareRunRef.current !== null
      )
        return;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;

      const userMessage: Message = { id: newMessageId(), role: "user", content: trimmed };
      if (hasImages) {
        userMessage.images = images;
      }
      if (imageThumbs !== undefined && imageThumbs.length > 0) {
        userMessage.imageThumbs = imageThumbs;
      }
      const outbound = [...session.messages, userMessage].map(forWire);
      const isFirstUserMessage = !session.messages.some((m) => m.role === "user");

      const targetMessageId = newMessageId();
      // A single-lane send has no pair to cancel together, so it hands
      // runGeneration a signal nobody holds: cancelGeneration() and
      // deleteSession() reach this run through the stream map instead.
      const send = new AbortController();
      setLastStats((prev) => (prev?.sessionId === sessionId ? null : prev));

      updateSession(sessionId, (s) => ({
        ...s,
        title: isFirstUserMessage ? titleFor(trimmed) : s.title,
        messages: [
          ...s.messages,
          userMessage,
          { id: targetMessageId, role: "assistant", content: "" },
        ],
        updatedAt: new Date().toISOString(),
      }));

      await runGeneration({
        sessionId,
        targetMessageId,
        model: session.model,
        messages: outbound,
        // Per-session, sent on every request for that session.
        options: session.options,
        think: session.think,
        signal: send.signal,
      });
    },
    [activeSessionId, runGeneration, updateSession],
  );

  /**
   * Sampling overrides and reasoning effort are settings, not activity, so
   * neither touches `updatedAt` — nudging a temperature slider shouldn't
   * shuffle the chat to the top of the sidebar.
   */
  const setSessionOptions = useCallback(
    (sessionId: string, options: RunOptions) => {
      updateSession(sessionId, (s) => ({ ...s, options }));
    },
    [updateSession],
  );

  const setSessionThink = useCallback(
    (sessionId: string, level: ThinkLevel) => {
      updateSession(sessionId, (s) => ({ ...s, think: level }));
    },
    [updateSession],
  );

  // ---- A/B compare (docs/SPEC-tuning.md T2) ----

  /**
   * Compare mode is a property of the session, so turning it on is a session
   * edit and not a mode flag somewhere else. Both lanes start as the chat's
   * current configuration: the question is always "is this change better than
   * what I have", and starting from two blanks would make the user re-state
   * what they already had before they could ask it.
   */
  const toggleCompare = useCallback(
    (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      if (session.compare !== undefined) {
        // Off keeps the transcript exactly as it is — only Keep this side
        // discards a lane, and it says so on the button.
        updateSession(sessionId, ({ compare: _off, ...rest }) => rest);
        return;
      }
      const model = modelsRef.current.find((m) => m.tag === session.model);
      const base: LaneConfig = {
        model: session.model,
        // A variant *is* a tag here, so the display name and the run target
        // are the same string; null marks a base model, per T2's data model.
        modelfile: model?.isVariant === true ? session.model : null,
      };
      if (session.options !== undefined) base.options = session.options;
      if (session.think !== undefined) base.think = session.think;
      const lanes: [LaneConfig, LaneConfig] = [base, { ...base }];
      updateSession(sessionId, (s) => ({
        ...s,
        // Pin now, not at send time, so the bar can name the seed the run
        // will use before the user commits to it.
        compare: { seed: neitherLaneSetsSeed(lanes) ? randomSeed() : null, lanes },
      }));
    },
    [updateSession],
  );

  const setLaneConfig = useCallback(
    (sessionId: string, lane: Lane, patch: Partial<LaneConfig>) => {
      updateSession(sessionId, (s) => {
        if (s.compare === undefined) return s;
        let compare = withLane(s.compare, lane, patch);
        // A lane that names its own seed has been told to differ deliberately.
        // Leaving the pin on would send the pinned value instead and make the
        // run ignore what the user just typed.
        if (patch.options?.seed !== undefined && compare.seed !== null) {
          compare = { ...compare, seed: null };
        }
        return { ...s, compare };
      });
    },
    [updateSession],
  );

  const setPinnedSeed = useCallback(
    (sessionId: string, seed: number | null) => {
      updateSession(sessionId, (s) =>
        s.compare === undefined ? s : { ...s, compare: { ...s.compare, seed } },
      );
    },
    [updateSession],
  );

  /**
   * One prompt, two lanes, **one at a time** (SPEC-tuning T2, SPEC §8).
   *
   * The await between the lanes is the feature, not an implementation
   * shortcut: two generations running together against one Ollama contend
   * for the same VRAM, and each lane's tok/s would then be measuring the
   * contention rather than the configuration it is supposed to be measuring.
   */
  const sendCompare = useCallback(
    async (text: string, images?: string[], imageThumbs?: string[]) => {
      const trimmed = text.trim();
      const sessionId = activeSessionId;
      const hasImages = images !== undefined && images.length > 0;
      if ((trimmed === "" && !hasImages) || sessionId === null) return;
      // One run at a time, still (SPEC §8) — a compare run is one run.
      if (streamsRef.current.size > 0 || compareRunRef.current !== null) return;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session || session.compare === undefined) return;
      const compare = session.compare;

      // Stored once, with no lane: it is one prompt. Two copies would show
      // the user asking the same question twice and would be re-sent as two
      // turns on the next exchange.
      const userMessage: Message = { id: newMessageId(), role: "user", content: trimmed };
      if (hasImages) {
        userMessage.images = images;
      }
      if (imageThumbs !== undefined && imageThumbs.length > 0) {
        userMessage.imageThumbs = imageThumbs;
      }
      const isFirstUserMessage = !session.messages.some((m) => m.role === "user");
      const history = [...session.messages, userMessage];
      const targets: Record<Lane, string> = { a: newMessageId(), b: newMessageId() };

      // One controller for the pair: Cancel stops the whole run, including
      // the lane that has not started yet.
      const controller = new AbortController();
      compareRunRef.current = { controller, sessionId };
      setLastStats((prev) => (prev?.sessionId === sessionId ? null : prev));

      updateSession(sessionId, (s) => ({
        ...s,
        title: isFirstUserMessage ? titleFor(trimmed) : s.title,
        messages: [
          ...s.messages,
          userMessage,
          { id: targets.a, role: "assistant", content: "", lane: "a" },
          { id: targets.b, role: "assistant", content: "", lane: "b" },
        ],
        updatedAt: new Date().toISOString(),
      }));

      try {
        for (const lane of LANES) {
          // A cancel during lane A must not be followed by lane B.
          if (controller.signal.aborted) break;
          setCompareRun({ sessionId, lane });
          const config = laneConfig(compare, lane);
          await runGeneration({
            sessionId,
            targetMessageId: targets[lane],
            model: config.model,
            // Each lane continues its own conversation: the other lane's
            // replies are not history it ever produced.
            messages: historyForLane(history, lane).map(forWire),
            options: effectiveLaneOptions(compare, lane),
            think: config.think,
            signal: controller.signal,
          });
        }
      } finally {
        compareRunRef.current = null;
        setCompareRun(null);
      }
    },
    [activeSessionId, runGeneration, updateSession],
  );

  /** Collapse onto one lane and discard the other (SPEC-tuning T2). */
  const keepLane = useCallback(
    (sessionId: string, lane: Lane) => {
      updateSession(sessionId, (s) => {
        if (s.compare === undefined) return s;
        const kept = laneConfig(s.compare, lane);
        const next: ChatSession = {
          id: s.id,
          title: s.title,
          // The session's identity is its model (SPEC §5.3), and the kept
          // lane is the configuration the user just chose.
          model: kept.model,
          messages: s.messages
            .filter((m) => m.lane === undefined || m.lane === lane)
            // The surviving replies are no longer one side of anything.
            .map(({ lane: _lane, ...rest }) => rest),
          updatedAt: s.updatedAt,
        };
        if (kept.options !== undefined) {
          next.options = kept.options;
        }
        if (kept.think !== undefined) {
          next.think = kept.think;
        }
        return next;
      });
    },
    [updateSession],
  );

  /**
   * Re-roll one reply in place (SPEC-tuning T6, item 3).
   *
   * The message keeps its id, so the stream lands back in the same slot and
   * the reply's position in the transcript — and, in compare mode, its lane —
   * is unchanged.
   */
  const regenerateReply = useCallback(
    async (sessionId: string, messageId: string, seed?: number) => {
      if (streamsRef.current.size > 0 || compareRunRef.current !== null) return;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      const index = session.messages.findIndex((m) => m.id === messageId);
      if (index === -1) return;
      const target = session.messages[index];
      if (target.role !== "assistant") return;

      // Everything before it — and, for a lane reply, only that lane's half
      // of it. Re-sending the other lane's answer as context would re-roll
      // against a conversation this lane never had.
      const before = session.messages.slice(0, index);
      const lane = target.lane;
      let model = session.model;
      let think = session.think;
      let baseOptions = session.options;
      let history = before;
      if (lane !== undefined) {
        history = historyForLane(before, lane);
        if (session.compare !== undefined) {
          const config = laneConfig(session.compare, lane);
          model = config.model;
          think = config.think;
          baseOptions = effectiveLaneOptions(session.compare, lane);
        }
      }
      // undefined holds the configured seed (re-roll the config); a number
      // replaces it for this request only (re-roll the sampling).
      const options = seed === undefined ? baseOptions : { ...baseOptions, seed };

      updateSession(sessionId, (s) => {
        const i = s.messages.findIndex((m) => m.id === messageId);
        if (i === -1) return s;
        const messages = [...s.messages];
        const { thinking: _thinking, ...rest } = messages[i];
        messages[i] = { ...rest, content: "" };
        return { ...s, messages };
      });
      setLastStats((prev) => (prev?.messageId === messageId ? null : prev));
      setStatsByMessage((prev) => {
        if (!(messageId in prev)) return prev;
        const { [messageId]: _dropped, ...rest } = prev;
        return rest;
      });

      await runGeneration({
        sessionId,
        targetMessageId: messageId,
        model,
        messages: history.map(forWire),
        options,
        think,
        signal: new AbortController().signal,
      });
    },
    [runGeneration, updateSession],
  );

  // ---- Modelfile editor (SPEC §5.4, §8) ----

  /** Every view change — tabs, sidebar nav, session open — funnels through here. */
  const setView = useCallback(
    (next: View) => {
      if (next === view) return;
      if (view === "modelfile" && !confirmUnsavedChanges()) return;
      setSaveError(null);
      setViewState(next);
    },
    [view, confirmUnsavedChanges],
  );

  const openEditor = useCallback(
    async (tag: string) => {
      // A dirty draft asks before being replaced — including re-opening the
      // SAME tag, which would otherwise silently reset the edits (SPEC §8).
      if (editorDraftRef.current?.dirty && !confirmUnsavedChanges()) return;
      setEditorError(null);
      setEditorLoading(true);
      try {
        const detail = await client.show(tag);
        const doc = parseModelfile(detail.modelfile);
        setEditorDraft({ targetTag: tag, doc, savedDoc: doc, dirty: false });
        setSaveError(null);
        setViewState("modelfile");
      } catch (err) {
        setEditorError(err instanceof Error ? err.message : String(err));
      } finally {
        setEditorLoading(false);
      }
    },
    [client, confirmUnsavedChanges],
  );

  const openEditorForNew = useCallback(
    (baseTag: string) => {
      if (!confirmUnsavedChanges()) return;
      // Minimal seed: FROM the chosen base, empty SYSTEM — the form fills in
      // the rest (SPEC §5.1's "＋ New Modelfile").
      const doc = parseModelfile(`FROM ${baseTag}\n`);
      setEditorDraft({ targetTag: null, doc, savedDoc: doc, dirty: false });
      setEditorError(null);
      setSaveError(null);
      setViewState("modelfile");
    },
    [confirmUnsavedChanges],
  );

  const bakeOptionsIntoEditor = useCallback(
    async (tag: string, options: RunOptions) => {
      // Deliberately not `await openEditor(tag)` then patch: editorDraftRef
      // is synced by an effect, so it still holds the PREVIOUS draft on the
      // line after openEditor resolves — reading it there baked nothing at
      // all, silently. Loading here instead keeps the draft and its `dirty`
      // flag correct in a single state write.
      if (editorDraftRef.current?.dirty && !confirmUnsavedChanges()) return;
      setEditorError(null);
      setEditorLoading(true);
      try {
        const detail = await client.show(tag);
        const savedDoc = parseModelfile(detail.modelfile);
        let doc = savedDoc;
        for (const [key, parameterName] of RUN_OPTION_KEYS) {
          const value = options[key];
          if (value !== undefined) {
            doc = setParameter(doc, parameterName, value);
          }
        }
        // Nothing overridden ⇒ pristine draft, so the unsaved-changes guard
        // doesn't fire on a Modelfile the user only looked at.
        setEditorDraft({ targetTag: tag, doc, savedDoc, dirty: doc !== savedDoc });
        setSaveError(null);
        setViewState("modelfile");
      } catch (err) {
        setEditorError(err instanceof Error ? err.message : String(err));
      } finally {
        setEditorLoading(false);
      }
    },
    [client, confirmUnsavedChanges],
  );

  const setEditorDoc = useCallback((doc: ModelfileDoc) => {
    setEditorDraft((prev) => (prev ? { ...prev, doc, dirty: true } : prev));
  }, []);

  const revertEditor = useCallback(() => {
    // Re-parse into a FRESH doc object: the editor's raw-pane resync effect
    // is keyed on savedDoc's identity, so reverting must change it or the
    // pane keeps showing the discarded edit (source-of-truth desync).
    setEditorDraft((prev) => {
      if (!prev) return prev;
      const fresh = parseModelfile(serializeModelfile(prev.savedDoc));
      // Revert discards a restored text along with everything else, so the
      // next Save is an ordinary "save", not a "restore" (SPEC-tuning T1).
      return { ...prev, doc: fresh, savedDoc: fresh, dirty: false, restoredFromId: null };
    });
    setSaveError(null);
  }, []);

  /**
   * Append a snapshot for `tag` (T1). Content-addressed inside
   * appendSnapshot: a save that changed no text returns the same array and
   * writes nothing, so the timeline never fills with identical entries.
   *
   * The kind a Save carries after a Restore is "restore" — that is the whole
   * point of the round trip. A *Save as…* after a restore stays "saveas",
   * because it forks a new tag rather than putting the old one back.
   */
  const recordSnapshot = useCallback(
    (tag: string, rawText: string, kind: ModelfileSnapshot["kind"], draft: EditorDraft) => {
      const restoredFrom = draft.restoredFromId ?? null;
      const effectiveKind = kind === "save" && restoredFrom !== null ? "restore" : kind;
      const previous = snapshotsForTag(historyRef.current, tag)[0] ?? null;
      const snapshot: ModelfileSnapshot = {
        id: newSnapshotId(),
        tag,
        rawText,
        savedAt: new Date().toISOString(),
        kind: effectiveKind,
        parentId: restoredFrom ?? previous?.id ?? null,
      };
      const next = appendSnapshot(historyRef.current, snapshot);
      if (next === historyRef.current) return; // unchanged text — nothing to record
      historyRef.current = next;
      setModelfileHistory(next);
      saveHistory(next);
    },
    [],
  );

  const historyForTag = useCallback(
    (tag: string | null) => snapshotsForTag(modelfileHistory, tag),
    [modelfileHistory],
  );

  /** SPEC-tuning T1: Restore loads text into the draft. It never creates. */
  const restoreSnapshot = useCallback((id: string) => {
    const snapshot = historyRef.current.find((s) => s.id === id);
    if (!snapshot) return;
    setEditorDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        doc: parseModelfile(snapshot.rawText),
        dirty: true,
        externalEdit: (prev.externalEdit ?? 0) + 1,
        restoredFromId: snapshot.id,
      };
    });
    setSaveError(null);
    setEditorPane("raw");
  }, []);

  const promoteToSystem = useCallback(
    async (text: string) => {
      const target = activeModelRef.current?.variant ?? null;
      if (target === null) return;
      if (editorDraftRef.current?.dirty && !confirmUnsavedChanges()) return;
      setEditorError(null);
      setEditorLoading(true);
      try {
        // Same shape as bakeOptionsIntoEditor: load and patch in one state
        // write, because editorDraftRef still holds the PREVIOUS draft on
        // the line after openEditor resolves. Nothing is created and nothing
        // is saved — the draft is dirty and the user presses Save.
        const detail = await client.show(target);
        const savedDoc = parseModelfile(detail.modelfile);
        const doc = setSystem(savedDoc, text);
        setEditorDraft({
          targetTag: target,
          doc,
          savedDoc,
          dirty: doc !== savedDoc,
          externalEdit: 1,
        });
        setSaveError(null);
        setEditorPane("form");
        setViewState("modelfile");
      } catch (err) {
        setEditorError(err instanceof Error ? err.message : String(err));
      } finally {
        setEditorLoading(false);
      }
    },
    [client, confirmUnsavedChanges],
  );

  const saveDraft = useCallback(
    async (asName?: string, quantize?: string) => {
      const draft = editorDraftRef.current;
      if (!draft) return;
      const targetName = asName ?? draft.targetTag;
      if (!targetName) return; // no target yet — Save as… is required to name one

      // SPEC §8: destructive overwrite confirms when the Settings "Confirm
      // before deleting a model" toggle is on (default on) — the same toggle
      // that gates model delete (LoadPane.tsx).
      if (!asName && confirmDeleteModel && !window.confirm(`Overwrite ${targetName}'s Modelfile?`)) return;

      setSaving(true);
      setSaveError(null);
      const oldTag = activeModelRef.current?.variant ?? null;
      try {
        const request = toCreateRequest(draft.doc);
        // Structured-create only; the client refuses to fall back to the
        // legacy body when this is set rather than drop it silently.
        if (quantize !== undefined && quantize !== "") {
          request.quantize = quantize;
        }
        setReloadToast({ phase: "creating", oldTag, newTag: targetName });
        for await (const status of client.create(targetName, request)) {
          setReloadToast({ phase: "creating", oldTag, newTag: targetName, detail: status.status });
        }
        // T1: snapshot only once the create has actually landed. Recording
        // before the loop — or outside this try — would fill the timeline
        // with Modelfiles Ollama rejected, which is the opposite of a
        // safety net. Everything after this point (unload, load, refresh)
        // can fail without unwriting a model that now exists.
        recordSnapshot(targetName, serializeModelfile(draft.doc), asName ? "saveas" : "save", draft);
        if (oldTag) {
          setReloadToast({ phase: "stopping", oldTag, newTag: targetName });
          await client.unload(oldTag);
        }
        setReloadToast({ phase: "reloading", oldTag, newTag: targetName });
        await client.load(targetName, keepAlive);
        await refreshModels();
        setReloadToast({ phase: "done", oldTag, newTag: targetName });
        // Only restore the saved draft if the editor still holds it — the
        // user may have opened another model's Modelfile mid-save, and
        // clobbering that draft with this one would discard their edits.
        if (editorDraftRef.current === draft) {
          setEditorDraft({ targetTag: targetName, doc: draft.doc, savedDoc: draft.doc, dirty: false });
        }
        window.setTimeout(() => {
          setReloadToast(null);
          // Snap back to chat only if the user is still where the save left
          // them; navigating away mid-save shouldn't be yanked back.
          if (viewRef.current === "modelfile") setViewState("chat");
        }, 1200);
      } catch (err) {
        // SPEC §9: surfaced verbatim by the save bar; the editor stays intact and dirty.
        setSaveError(err instanceof Error ? err.message : String(err));
        setReloadToast(null);
      } finally {
        setSaving(false);
      }
    },
    [client, keepAlive, refreshModels, confirmDeleteModel, recordSnapshot],
  );

  // Memoized: chat streaming updates `sessions` once per token, and an
  // unmemoized literal here would re-render every consumer app-wide on each
  // one. The inline pane open/close closures are hoisted for the same reason.
  const openLoadPane = useCallback(() => setLoadPaneOpen(true), []);
  const closeLoadPane = useCallback(() => setLoadPaneOpen(false), []);
  const value: RemudaContextValue = useMemo(() => ({
    client,
    status,
    checked,
    models,
    groups,
    running,
    loaded,
    activeModel,
    keepAlive,
    setKeepAlive,
    confirmDeleteModel,
    setConfirmDeleteModel,
    view,
    setView,
    loadPaneOpen,
    openLoadPane,
    closeLoadPane,
    refreshModels,
    load,
    unload,
    unloadAll,
    setKept,
    checkHealth,
    sessions,
    activeSessionId,
    streamingSessionId,
    streamError,
    errorsByMessage,
    lastStats,
    statsByMessage,
    compareRun,
    newChat,
    openSession,
    deleteSession,
    sendMessage,
    runGeneration,
    setSessionOptions,
    setSessionThink,
    toggleCompare,
    setLaneConfig,
    setPinnedSeed,
    sendCompare,
    keepLane,
    regenerateReply,
    bakeOptionsIntoEditor,
    cancelGeneration,
    editorDraft,
    editorLoading,
    editorError,
    openEditor,
    openEditorForNew,
    setEditorDoc,
    revertEditor,
    saving,
    saveError,
    reloadToast,
    saveDraft,
    modelfileHistory,
    historyForTag,
    editorPane,
    setEditorPane,
    restoreSnapshot,
    promoteToSystem,
  }), [
    client, status, checked, models, groups, running, loaded, activeModel, keepAlive,
    confirmDeleteModel, setConfirmDeleteModel, view, setView, loadPaneOpen,
    openLoadPane, closeLoadPane, refreshModels, load, unload, unloadAll, setKept,
    checkHealth, sessions,
    activeSessionId, streamingSessionId, streamError, errorsByMessage, lastStats, statsByMessage,
    compareRun, newChat,
    openSession, deleteSession, sendMessage, runGeneration, setSessionOptions, setSessionThink,
    toggleCompare, setLaneConfig, setPinnedSeed, sendCompare, keepLane, regenerateReply,
    bakeOptionsIntoEditor, cancelGeneration, editorDraft,
    editorLoading, editorError, openEditor, openEditorForNew, setEditorDoc,
    revertEditor, saving, saveError, reloadToast, saveDraft,
    modelfileHistory, historyForTag, editorPane, setEditorPane, restoreSnapshot,
    promoteToSystem,
  ]);

  return <RemudaContext.Provider value={value}>{children}</RemudaContext.Provider>;
}

export function useRemuda(): RemudaContextValue {
  const ctx = useContext(RemudaContext);
  if (!ctx) {
    throw new Error("useRemuda must be used within a RemudaProvider");
  }
  return ctx;
}
