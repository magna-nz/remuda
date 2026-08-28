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
  /**
   * What the server says this model can do ("tools", "thinking", "vision",
   * …), from POST /api/show. Deliberately `string[]` and not a closed union:
   * Ollama adds capabilities over time and a narrow union would fail to
   * compile against a server newer than this build (pull/catalog.ts takes the
   * same line for the same reason). Empty when the server doesn't report any
   * — including every server old enough to omit the field, and the
   * /api/tags-only path (listModels), which never asks /api/show.
   */
  capabilities: string[];
}

/**
 * A model currently in memory (GET /api/ps) — the SIZE / PROCESSOR / CONTEXT
 * / UNTIL columns of `ollama ps`.
 *
 * Everything past `tag` is defensive: older servers omit `size_vram`,
 * `context_length` and `expires_at` entirely, so a missing field reads as
 * 0/null rather than NaN or undefined.
 */
export interface RunningModel {
  /** Full tag as the server reports it. */
  tag: string;
  /** Total bytes the runner holds (VRAM + system RAM). */
  sizeBytes: number;
  /** Bytes resident in VRAM. 0 means the model is running entirely on CPU. */
  sizeVramBytes: number;
  /** Context window the runner was started with; null when the server omits it. */
  contextLength: number | null;
  /** ISO 8601 keep_alive expiry; null when absent, or when keep_alive is infinite. */
  expiresAt: string | null;
}

/**
 * /api/tags and /api/ps read together (see OllamaClient.listModelsWithRunning).
 * One trip, two answers: the installed set, and what of it is resident.
 */
export interface ModelSnapshot {
  models: Model[];
  running: RunningModel[];
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
  /** See Model.capabilities. `[]` when the server doesn't report any. */
  capabilities: string[];
  /** Architecture-derived sizing from /api/show's `model_info`, for the
   * memory-estimate math. `null` unless every one of the four numbers was
   * present and numeric — a partial reading is worse than none, because a
   * wrong figure costs the user a five-minute model load. */
  archParams: ArchParams | null;
}

/** Architecture parameters read from POST /api/show's `model_info`
 * (`general.architecture` plus that architecture's block_count /
 * attention.head_count / attention.head_count_kv / embedding_length). */
export interface ArchParams {
  architecture: string;
  /**
   * Explicit per-head key/value dimensions (`{arch}.attention.key_length` /
   * `.value_length`), when the server reports them.
   *
   * These are NOT always `embeddingLength / headCount`. Qwen3, for one,
   * declares key_length 256 with embedding_length 5120 and head_count 24 —
   * deriving would give a *fractional* 213.33 and a KV estimate 17% low.
   * Absent on architectures that don't declare them, where deriving is right.
   */
  keyLength?: number;
  valueLength?: number;
  blockCount: number;
  headCount: number;
  headCountKv: number;
  embeddingLength: number;
}

/**
 * Reasoning effort for a thinking-capable model. "off" omits `think` entirely.
 */
export type ThinkLevel = "off" | "low" | "medium" | "high";

export interface ChatMessage {
  /**
   * `"tool"` carries a tool's result back to the model (T3). It is a real
   * wire role, not a UI-only one — Ollama expects the result of a call to
   * come back under it.
   */
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Tool calls the assistant emitted. Echoed back on the outbound history so
   * the model sees its own call alongside the result it is being handed —
   * without it the server receives a `tool` message answering nothing.
   */
  toolCalls?: ToolCall[];
  /**
   * The tool a `role: "tool"` message is answering. Newer Ollama accepts it;
   * older servers ignore unknown keys, so it is always safe to send.
   */
  toolName?: string;
  /**
   * Accumulated reasoning on an assistant message (Ollama's
   * `message.thinking`). Kept out of `content` so the UI can fold it away —
   * and stripped from the outbound history, because Ollama does not take
   * reasoning back as context.
   */
  thinking?: string;
  /**
   * Attached images as raw base64 — no `data:` prefix, which is the shape
   * Ollama's wire format wants. In memory only: saveSessions() drops these
   * (localStorage's ~5MB quota), so a restored session has thumbs and no
   * images.
   */
  images?: string[];
  /**
   * Small `data:` URLs for redisplay — the ONLY image data that is
   * persisted. Never sent to the server.
   */
  imageThumbs?: string[];
}

/** One streamed chunk from POST /api/chat. */
export interface ChatChunk {
  content: string;
  /** Reasoning delta from `message.thinking`; never part of `content`. */
  thinking?: string;
  done: boolean;
  /**
   * Set on the final chunk (done: true). The two eval fields are required
   * because every server that reports timings at all reports those; the rest
   * are optional and absent on servers that don't.
   */
  stats?: {
    evalCount: number;
    evalDurationNs: number;
    promptEvalCount?: number;
    promptEvalDurationNs?: number;
    loadDurationNs?: number;
    totalDurationNs?: number;
  };
  /** Tool calls the model made this turn, from `message.tool_calls`. Present
   * only when the array is non-empty. */
  toolCalls?: ToolCall[];
}

/** One tool call from `message.tool_calls[].function`. Ollama returns
 * `arguments` as an already-parsed JSON object — unlike the OpenAI wire
 * format it borrows from — so this layer never calls `JSON.parse` on it. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Per-request sampling overrides (POST /api/chat `options`). camelCase here,
 * snake_case on the wire — the client maps and omits every unset key, since
 * an explicit `undefined` in the JSON body is not the same as absent.
 */
export interface RunOptions {
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  numPredict?: number;
  repeatPenalty?: number;
  /**
   * Load-time, not sampling: changing this makes Ollama reload the model
   * with a different memory footprint. The UI warns before applying it.
   */
  numCtx?: number;
}

/**
 * RunOptions → the name Ollama knows each value by, which is also the
 * Modelfile `PARAMETER` name. One list, because two copies drift: the wire
 * encoder in client.ts and the "Bake into Modelfile" action in state.tsx
 * both have to agree on what `topP` is called.
 */
export const RUN_OPTION_KEYS: Array<[keyof RunOptions, string]> = [
  ["temperature", "temperature"],
  ["topP", "top_p"],
  ["topK", "top_k"],
  ["seed", "seed"],
  ["numPredict", "num_predict"],
  ["repeatPenalty", "repeat_penalty"],
  ["numCtx", "num_ctx"],
];

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
  /**
   * Quantise the source weights on the way in, e.g. "q4_K_M". Structured
   * create only — the legacy `modelfile` string can't express it, so when
   * this is set the client will NOT fall back: dropping the quantisation
   * silently would produce a model the user didn't ask for.
   */
  quantize?: string;
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
  /**
   * listModels(), keeping the full /api/ps readout instead of reducing it to
   * `isLoaded`. Exactly the same two requests — the 5s poll calls this so the
   * runtime readout (SPEC §5.1) costs nothing extra.
   */
  listModelsWithRunning(): Promise<ModelSnapshot>;
  /**
   * GET /api/ps on its own. For callers that want only residency; the poll
   * path uses listModelsWithRunning instead of pairing this with listModels.
   */
  listRunning(): Promise<RunningModel[]>;
  /** Group models into base + variants for the load pane. */
  listGroups(): Promise<ModelGroup[]>;
  /** POST /api/show */
  show(tag: string): Promise<ModelDetail>;
  /**
   * Load a model into memory: warm POST /api/generate with empty prompt
   * and the configured keep_alive. Resolves when the model is loaded.
   */
  /**
   * `numCtx` is a load-time parameter, not a sampling one: it sizes the KV
   * cache the runner allocates, so it can only be set as the model is loaded
   * (SPEC §8). Omitted ⇒ Ollama's own default for the model.
   */
  load(
    tag: string,
    keepAlive: KeepAlive,
    signal?: AbortSignal,
    numCtx?: number,
  ): Promise<void>;
  /** Unload: POST /api/generate with keep_alive: 0. */
  unload(tag: string): Promise<void>;
  /**
   * POST /api/chat with stream: true. Yields chunks; respects signal for
   * cancel (dropping the stream stops generation server-side).
   */
  chat(
    tag: string,
    messages: ChatMessage[],
    opts: {
      keepAlive: KeepAlive;
      signal?: AbortSignal;
      /** "off"/undefined omits `think` from the body; the rest go verbatim. */
      think?: ThinkLevel;
      /** Sampling overrides; unset keys are omitted, not sent as null. */
      options?: RunOptions;
      /** Raw tool definitions, passed through verbatim; omitted from the
       * request body entirely when empty/unset rather than sent as `[]`. */
      tools?: unknown[];
    },
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
