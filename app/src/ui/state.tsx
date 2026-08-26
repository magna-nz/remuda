/**
 * Remuda's client-side store (SPEC.md §5, §5.1, §5.6, §9).
 *
 * A small React context — no external state library. Holds the OllamaClient
 * instance, server status (polled every 5s), the installed model list
 * (grouped into base + variants for the load pane), the currently loaded
 * selection, keep_alive, which top-level view is showing (chat vs.
 * settings), and the saved chat sessions (SPEC §5.2, §6) with the one
 * in-flight generation (SPEC §8). The model list refreshes on connect,
 * after load(), and after a completed chat exchange.
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
import { parseModelfile, type ModelfileDoc } from "../modelfile";
import { toCreateRequest } from "../modelfile/createRequest";

export type View = "chat" | "modelfile" | "settings";

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
  const [view, setViewState] = useState<View>("chat");
  const [loadPaneOpen, setLoadPaneOpen] = useState(false);
  const wasConnected = useRef(false);

  const [editorDraft, setEditorDraft] = useState<EditorDraft | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadToast, setReloadToast] = useState<ReloadToastState | null>(null);
  const editorDraftRef = useRef<EditorDraft | null>(null);
  editorDraftRef.current = editorDraft;

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

  const refreshModels = useCallback(async () => {
    const list = await client.listGroups();
    setGroups(list);
  }, [client]);

  const checkHealth = useCallback(async () => {
    try {
      const s = await client.version();
      setStatus(s);
      setChecked(true);
      if (s.connected && !wasConnected.current) {
        wasConnected.current = true;
        await refreshModels().catch(() => {});
      } else if (!s.connected) {
        wasConnected.current = false;
      }
    } catch {
      setStatus({ connected: false, version: null });
      setChecked(true);
      wasConnected.current = false;
    }
  }, [client, refreshModels]);

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
    const session = createSession(loaded.variant);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setViewState("chat");
  }, [loaded]);

  const openSession = useCallback((id: string) => {
    setActiveSessionId(id);
    setViewState("chat");
  }, []);

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
        void refreshModels().catch(() => {});
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
    [activeSessionId, client, keepAlive, refreshModels, updateSession],
  );

  // ---- Modelfile editor (SPEC §5.4, §8) ----

  /** SPEC §8: unsaved editor changes prompt before navigating away. */
  const confirmUnsavedChanges = useCallback((): boolean => {
    if (!editorDraftRef.current?.dirty) return true;
    return window.confirm("Discard unsaved Modelfile changes?");
  }, []);

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
      if (editorDraftRef.current?.targetTag !== tag && !confirmUnsavedChanges()) return;
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
    setEditorDraft((prev) => (prev ? { ...prev, doc: prev.savedDoc, dirty: false } : prev));
    setSaveError(null);
  }, []);

  const saveDraft = useCallback(
    async (asName?: string) => {
      const draft = editorDraftRef.current;
      if (!draft) return;
      const targetName = asName ?? draft.targetTag;
      if (!targetName) return; // no target yet — Save as… is required to name one

      // SPEC §8: destructive overwrite confirms when the Settings toggle is
      // on. Settings' "Confirm before deleting a model" toggle (Settings.tsx)
      // is local component state today and isn't wired into this store, so
      // this defaults to the spec's default-on behavior for an overwrite.
      if (!asName && !window.confirm(`Overwrite ${targetName}'s Modelfile?`)) return;

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
        setEditorDraft({ targetTag: targetName, doc: draft.doc, savedDoc: draft.doc, dirty: false });
        window.setTimeout(() => {
          setReloadToast(null);
          setViewState("chat");
        }, 1200);
      } catch (err) {
        // SPEC §9: surfaced verbatim by the save bar; the editor stays intact and dirty.
        setSaveError(err instanceof Error ? err.message : String(err));
        setReloadToast(null);
      } finally {
        setSaving(false);
      }
    },
    [client, loaded, keepAlive, refreshModels],
  );

  const value: RemudaContextValue = {
    client,
    status,
    checked,
    models,
    groups,
    loaded,
    keepAlive,
    setKeepAlive,
    view,
    setView,
    loadPaneOpen,
    openLoadPane: () => setLoadPaneOpen(true),
    closeLoadPane: () => setLoadPaneOpen(false),
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
  };

  return <RemudaContext.Provider value={value}>{children}</RemudaContext.Provider>;
}

export function useRemuda(): RemudaContextValue {
  const ctx = useContext(RemudaContext);
  if (!ctx) {
    throw new Error("useRemuda must be used within a RemudaProvider");
  }
  return ctx;
}
