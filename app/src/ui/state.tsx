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
  ServerStatus,
} from "../api/types";
import {
  createSession,
  loadSessions,
  saveSessions,
  sortSessions,
  titleFor,
  type ChatSession,
} from "../chat/sessions";
// M3 — owned by a concurrent agent (app/src/modelfile/). Consumed here, not
// redeclared: parseModelfile/serializeModelfile plus toCreateRequest are the
// editor's sync contract with the raw Modelfile (SPEC.md §5.4).
import { parseModelfile, serializeModelfile, type ModelfileDoc } from "../modelfile";
import { toCreateRequest } from "../modelfile/createRequest";

export type View = "chat" | "modelfile" | "pull" | "settings";

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
}

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

interface RemudaContextValue {
  client: OllamaClient;
  /** Latest health check result. */
  status: ServerStatus;
  /** True once the first health check has resolved (success or failure). */
  checked: boolean;
  models: Model[];
  groups: ModelGroup[];
  loaded: LoadedSelection | null;
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
  load: (tag: string) => Promise<void>;
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
  /** tok/s of the last completed reply, tied to its session. */
  lastStats: { sessionId: string; tokPerSec: number } | null;
  /** New session on the currently loaded model; no-op when nothing is loaded. */
  newChat: () => void;
  openSession: (id: string) => void;
  deleteSession: (id: string) => void;
  /** Append the user message and stream the assistant reply (SPEC §5.3). */
  sendMessage: (text: string) => Promise<void>;
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
   * `editorDraft.targetTag`.
   */
  saveDraft: (asName?: string) => Promise<void>;
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

function deriveLoaded(models: Model[]): LoadedSelection | null {
  const loadedModel = models.find((m) => m.isLoaded);
  if (!loadedModel) return null;
  return loadedModel.isVariant && loadedModel.base
    ? { base: loadedModel.base, variant: loadedModel.tag }
    : { base: loadedModel.tag, variant: loadedModel.tag };
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
  const [keepAlive, setKeepAlive] = useState<KeepAlive>("5m");
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

  /** SPEC §8: unsaved editor changes prompt before navigating away. */
  const confirmUnsavedChanges = useCallback((): boolean => {
    if (!editorDraftRef.current?.dirty) return true;
    return window.confirm("Discard unsaved Modelfile changes?");
  }, []);

  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [lastStats, setLastStats] = useState<{ sessionId: string; tokPerSec: number } | null>(
    null,
  );
  /** The in-flight generation; also the synchronous one-at-a-time guard (SPEC §8). */
  const streamRef = useRef<{ controller: AbortController; sessionId: string } | null>(null);
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

  const refreshModels = useCallback(async () => {
    const list = await client.listGroups();
    setGroups(list);
    installedSignature.current = signatureOfGroups(list);
  }, [client]);

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
    const list = await client.listModels();
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
  }, [client, refreshModels]);

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
      }
    } catch {
      setStatus({ connected: false, version: null });
      setChecked(true);
      wasConnected.current = false;
      installedSignature.current = null;
    }
  }, [client, syncModels]);

  useEffect(() => {
    void checkHealth();
    const id = window.setInterval(() => {
      void checkHealth();
    }, pollIntervalMs);
    return () => window.clearInterval(id);
  }, [checkHealth, pollIntervalMs]);

  const load = useCallback(
    async (tag: string) => {
      await client.load(tag, keepAlive);
      await refreshModels();
    },
    [client, keepAlive, refreshModels],
  );

  const models = useMemo(
    () => groups.flatMap((g) => [g.base, ...g.variants]),
    [groups],
  );
  const loaded = useMemo(() => deriveLoaded(models), [models]);

  /** Apply fn to one session and keep the list sorted most-recent first. */
  const updateSession = useCallback((id: string, fn: (s: ChatSession) => ChatSession) => {
    setSessions((prev) => sortSessions(prev.map((s) => (s.id === id ? fn(s) : s))));
  }, []);

  const newChat = useCallback(() => {
    // §5.2: New chat opens on the *currently loaded* model — nothing loaded,
    // nothing to bind the session to.
    if (!loaded) return;
    // The sidebar stays visible while the Modelfile editor is open, so this
    // is a navigation away from it — same unsaved-changes gate as setView
    // (SPEC §8), not a silent discard.
    if (viewRef.current === "modelfile" && !confirmUnsavedChanges()) return;
    const session = createSession(loaded.variant);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setStreamError(null);
    setViewState("chat");
  }, [loaded, confirmUnsavedChanges]);

  const openSession = useCallback((id: string) => {
    if (viewRef.current === "modelfile" && !confirmUnsavedChanges()) return;
    setActiveSessionId(id);
    // A previous session's failure isn't this one's (it renders globally).
    setStreamError(null);
    setViewState("chat");
  }, [confirmUnsavedChanges]);

  const deleteSession = useCallback((id: string) => {
    if (streamRef.current?.sessionId === id) {
      streamRef.current.controller.abort();
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveSessionId((prev) => (prev === id ? null : prev));
    setLastStats((prev) => (prev?.sessionId === id ? null : prev));
  }, []);

  const cancelGeneration = useCallback(() => {
    streamRef.current?.controller.abort();
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      const sessionId = activeSessionId;
      // One streamed generation at a time (SPEC §8).
      if (trimmed === "" || sessionId === null || streamRef.current !== null) return;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;

      const userMessage: ChatMessage = { role: "user", content: trimmed };
      const outbound = [...session.messages, userMessage];
      const isFirstUserMessage = !session.messages.some((m) => m.role === "user");

      const controller = new AbortController();
      streamRef.current = { controller, sessionId };
      setStreamingSessionId(sessionId);
      setStreamError(null);
      setLastStats((prev) => (prev?.sessionId === sessionId ? null : prev));

      updateSession(sessionId, (s) => ({
        ...s,
        title: isFirstUserMessage ? titleFor(trimmed) : s.title,
        messages: [...s.messages, userMessage, { role: "assistant", content: "" }],
        updatedAt: new Date().toISOString(),
      }));

      try {
        for await (const chunk of client.chat(session.model, outbound, {
          keepAlive,
          signal: controller.signal,
        })) {
          if (chunk.content !== "") {
            updateSession(sessionId, (s) => {
              const messages = [...s.messages];
              const last = messages[messages.length - 1];
              if (last?.role !== "assistant") return s;
              messages[messages.length - 1] = { ...last, content: last.content + chunk.content };
              return { ...s, messages };
            });
          }
          if (chunk.done && chunk.stats && chunk.stats.evalDurationNs > 0) {
            setLastStats({
              sessionId,
              tokPerSec: Math.round(chunk.stats.evalCount / (chunk.stats.evalDurationNs / 1e9)),
            });
          }
        }
        // Completed exchange: bump updatedAt (§6) and re-check /api/ps —
        // Ollama loads on demand, so the session's model may be loaded now.
        updateSession(sessionId, (s) => ({ ...s, updatedAt: new Date().toISOString() }));
        void syncModels().catch(() => {});
      } catch (err) {
        // Cancel keeps the partial reply and isn't an error (SPEC §5.3).
        const aborted =
          controller.signal.aborted ||
          (err instanceof Error && err.name === "AbortError");
        if (!aborted) {
          setStreamError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        streamRef.current = null;
        setStreamingSessionId(null);
      }
    },
    [activeSessionId, client, keepAlive, syncModels, updateSession],
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
      return { ...prev, doc: fresh, savedDoc: fresh, dirty: false };
    });
    setSaveError(null);
  }, []);

  const saveDraft = useCallback(
    async (asName?: string) => {
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
      const oldTag = loaded?.variant ?? null;
      try {
        const request = toCreateRequest(draft.doc);
        setReloadToast({ phase: "creating", oldTag, newTag: targetName });
        for await (const status of client.create(targetName, request)) {
          setReloadToast({ phase: "creating", oldTag, newTag: targetName, detail: status.status });
        }
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
    [client, loaded, keepAlive, refreshModels, confirmDeleteModel],
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
    loaded,
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
    checkHealth,
    sessions,
    activeSessionId,
    streamingSessionId,
    streamError,
    lastStats,
    newChat,
    openSession,
    deleteSession,
    sendMessage,
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
  }), [
    client, status, checked, models, groups, loaded, keepAlive,
    confirmDeleteModel, setConfirmDeleteModel, view, setView, loadPaneOpen,
    openLoadPane, closeLoadPane, refreshModels, load, checkHealth, sessions,
    activeSessionId, streamingSessionId, streamError, lastStats, newChat,
    openSession, deleteSession, sendMessage, cancelGeneration, editorDraft,
    editorLoading, editorError, openEditor, openEditorForNew, setEditorDoc,
    revertEditor, saving, saveError, reloadToast, saveDraft,
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
