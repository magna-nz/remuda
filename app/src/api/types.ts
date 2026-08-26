/**
 * Remuda ↔ Ollama API contract (SPEC.md §6–§7).
 *
 * This file is the single source of truth for the shapes crossing the
 * client/UI boundary. UI code imports from here — never redeclares.
 * The client module (client.ts) implements OllamaClient against these.
 */

/** An installed model, merged from /api/tags + /api/ps + /api/show. */
export interface Model {
  /** Full tag, e.g. "llama3.1:8b" */
  tag: string;
  family: string;
  parameterSize: string;
  quantization: string;
  sizeBytes: number;
  contextLength: number | null;
  /** In memory right now (from /api/ps). */
  isLoaded: boolean;
  /** FROM target when it resolves to another local model; null for a base. */
  base: string | null;
  /** base !== null */
  isVariant: boolean;
  modifiedAt: string; // ISO 8601
}

/** Grouping for the load pane's Modelfile picker: base → its variants. */
export interface ModelGroup {
  base: Model;
  variants: Model[];
}

export interface ServerStatus {
  connected: boolean;
  version: string | null;
}

/** Detail from POST /api/show. */
export interface ModelDetail {
  tag: string;
  modelfile: string;
  parameters: string;
  template: string;
  system: string;
  details: {
    family: string;
    parameterSize: string;
    quantizationLevel: string;
  };
  contextLength: number | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** One streamed chunk from POST /api/chat. */
export interface ChatChunk {
  content: string;
  done: boolean;
  /** Set on the final chunk (done: true). */
  stats?: { evalCount: number; evalDurationNs: number };
}

/** One streamed progress event from POST /api/pull. */
export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/** One streamed status line from POST /api/create. */
export interface CreateStatus {
  status: string;
}

/**
 * Payload for POST /api/create. Current Ollama (≥0.5.x) takes structured
 * fields; older servers take a raw `modelfile` string. The client sends the
 * structured form first and falls back to the legacy form on rejection
 * (SPEC §9 version skew). Both derive from the same raw Modelfile — the
 * modelfile module (M3) produces this from parsed text.
 */
export interface CreateRequest {
  from: string;
  system?: string;
  template?: string;
  license?: string;
  /** MESSAGE instructions, in order (structured create's `messages`). */
  messages?: ChatMessage[];
  /** PARAMETER lines; repeatable keys (stop) become arrays. */
  parameters?: Record<string, string | number | boolean | Array<string | number>>;
  /** The raw Modelfile text, for the legacy fallback. */
  rawModelfile: string;
}

/** keep_alive values Remuda exposes (SPEC §5.6). */
export type KeepAlive = "5m" | "30m" | -1;

export interface OllamaClient {
  /** GET /api/version — also the health check. */
  version(): Promise<ServerStatus>;
  /** GET /api/tags merged with GET /api/ps. */
  listModels(): Promise<Model[]>;
  /** Group models into base + variants for the load pane. */
  listGroups(): Promise<ModelGroup[]>;
  /** POST /api/show */
  show(tag: string): Promise<ModelDetail>;
  /**
   * Load a model into memory: warm POST /api/generate with empty prompt
   * and the configured keep_alive. Resolves when the model is loaded.
   */
  load(tag: string, keepAlive: KeepAlive, signal?: AbortSignal): Promise<void>;
  /** Unload: POST /api/generate with keep_alive: 0. */
  unload(tag: string): Promise<void>;
  /**
   * POST /api/chat with stream: true. Yields chunks; respects signal for
   * cancel (dropping the stream stops generation server-side).
   */
  chat(
    tag: string,
    messages: ChatMessage[],
    opts: { keepAlive: KeepAlive; signal?: AbortSignal },
  ): AsyncIterable<ChatChunk>;
  /** POST /api/create with stream: true — structured body first, legacy
   * `modelfile` fallback for older servers (SPEC §9). */
  create(
    name: string,
    request: CreateRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CreateStatus>;
  /** POST /api/pull with stream: true. */
  pull(tag: string, signal?: AbortSignal): AsyncIterable<PullProgress>;
  /** DELETE /api/delete */
  deleteModel(tag: string): Promise<void>;
  /** POST /api/copy */
  copy(source: string, destination: string): Promise<void>;
}

/** Factory: baseUrl defaults to Ollama's loopback default (SPEC §3). */
export const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
