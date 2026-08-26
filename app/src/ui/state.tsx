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

export type View = "chat" | "settings";

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
  const [view, setView] = useState<View>("chat");
  const [loadPaneOpen, setLoadPaneOpen] = useState(false);
  const wasConnected = useRef(false);

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

  useEffect(() => {
    saveSessions(sessions);
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
    setView("chat");
  }, [loaded]);

  const openSession = useCallback((id: string) => {
    setActiveSessionId(id);
    setView("chat");
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
