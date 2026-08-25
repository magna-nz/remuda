/**
 * Remuda's client-side store (SPEC.md §5, §5.1, §5.6, §9).
 *
 * A small React context — no external state library. Holds the OllamaClient
 * instance, server status (polled every 5s), the installed model list
 * (grouped into base + variants for the load pane), the currently loaded
 * selection, keep_alive, and which top-level view is showing (chat vs.
 * settings). The model list refreshes on connect and after load().
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
import type { KeepAlive, Model, ModelGroup, OllamaClient, ServerStatus } from "../api/types";

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
}

const RemudaContext = createContext<RemudaContextValue | null>(null);

function deriveLoaded(models: Model[]): LoadedSelection | null {
  const loadedModel = models.find((m) => m.isLoaded);
  if (!loadedModel) return null;
  return loadedModel.isVariant && loadedModel.base
    ? { base: loadedModel.base, variant: loadedModel.tag }
    : { base: loadedModel.tag, variant: loadedModel.tag };
}

function groupModels(models: Model[]): ModelGroup[] {
  const bases = models.filter((m) => !m.isVariant);
  return bases.map((base) => ({
    base,
    variants: models.filter((m) => m.isVariant && m.base === base.tag),
  }));
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
  const [models, setModels] = useState<Model[]>([]);
  const [keepAlive, setKeepAlive] = useState<KeepAlive>("5m");
  const [view, setView] = useState<View>("chat");
  const [loadPaneOpen, setLoadPaneOpen] = useState(false);
  const wasConnected = useRef(false);

  const refreshModels = useCallback(async () => {
    const list = await client.listModels();
    setModels(list);
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

  const groups = useMemo(() => groupModels(models), [models]);
  const loaded = useMemo(() => deriveLoaded(models), [models]);

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
