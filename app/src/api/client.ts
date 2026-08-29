/**
 * Ollama HTTP client (SPEC.md §3, §6, §7). Implements the frozen contract
 * in types.ts against Ollama's local API. All requests go to the configured
 * base URL, which defaults to loopback.
 */
import type {
  ArchParams,
  ChatChunk,
  ChatMessage,
  CreateRequest,
  CreateStatus,
  KeepAlive,
  Model,
  ModelDetail,
  ModelGroup,
  ModelSnapshot,
  OllamaClient,
  PullProgress,
  RunOptions,
  RunningModel,
  ServerStatus,
  ThinkLevel,
  ToolCall,
} from "./types";
import { DEFAULT_BASE_URL, RUN_OPTION_KEYS } from "./types";
import { ndjson } from "./ndjson";

/* ── Wire shapes (Ollama's JSON, snake_case) ────────────────────────────── */

interface WireDetails {
  family?: string;
  parameter_size?: string;
  quantization_level?: string;
  /** Tag this model was created FROM; "" for a model that isn't derived. */
  parent_model?: string;
}

interface WireTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    modified_at?: string;
    details?: WireDetails;
  }>;
}

interface WirePsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    /** Total bytes held by the runner (VRAM + system RAM). */
    size?: number;
    /** Bytes in VRAM; absent on servers that predate the field. */
    size_vram?: number;
    /** Context the runner was started with; absent on older servers. */
    context_length?: number;
    /** keep_alive expiry; "0001-01-01T00:00:00Z" means "never". */
    expires_at?: string;
  }>;
}

interface WireShowResponse {
  modelfile?: string;
  parameters?: string;
  template?: string;
  system?: string;
  details?: WireDetails;
  model_info?: Record<string, unknown>;
  /** e.g. ["completion","tools","thinking"]; absent on older servers. */
  capabilities?: unknown;
}

interface WireChatLine {
  message?: { content?: string; thinking?: string; tool_calls?: unknown };
  done?: boolean;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
  error?: string;
}

interface WireStreamLine {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Non-2xx → Error whose message carries the status and the server's
 * `error` field verbatim when present (SPEC §9). */
async function requireOk(res: Response, path: string): Promise<Response> {
  if (res.ok) {
    return res;
  }
  let detail = "";
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      detail = typeof parsed.error === "string" ? parsed.error : text;
    } catch {
      detail = text;
    }
  } catch {
    // Body unreadable; the status alone will have to do.
  }
  const suffix = detail === "" ? "" : `: ${detail}`;
  throw new Error(`Ollama ${path} failed (${res.status})${suffix}`);
}

/** A stream from a 2xx response with no body is a server bug; fail loudly. */
function requireBody(res: Response, path: string): ReadableStream<Uint8Array> {
  if (!res.body) {
    throw new Error(`Ollama ${path} returned no response body`);
  }
  return res.body;
}

/** Lowercase and strip an explicit or implicit ":latest" so
 * "llama3.1", "llama3.1:latest", and "LLAMA3.1:LATEST" all compare equal. */
function normalizeTag(tag: string): string {
  const lower = tag.trim().toLowerCase();
  return lower.endsWith(":latest") ? lower.slice(0, -":latest".length) : lower;
}

/**
 * The FROM target of a Modelfile, or null. Ollama's /api/show returns a
 * reconstructed modelfile whose FROM line is a blob path
 * (`FROM /…/blobs/sha256-…`); the actual model-name reference, when it
 * resolves to another local model, shows up in a `# FROM <name>` comment
 * line instead. Prefer that comment; fall back to a FROM line whose value
 * doesn't look like a path.
 *
 * Note this is only the *fallback* for deriving a base: current Ollama names
 * the parent outright in `details.parent_model`, and the `# FROM` comment it
 * writes today is the model's own tag rather than its parent's, so on those
 * servers this function contributes nothing. It stays for servers that
 * predate `parent_model`.
 */
function parseFrom(modelfile: string): string | null {
  let fallback: string | null = null;
  for (const raw of modelfile.split("\n")) {
    const line = raw.trim();
    const commentMatch = /^#\s*from\s+(.+)$/i.exec(line);
    if (commentMatch) {
      return commentMatch[1].trim();
    }
    if (fallback === null) {
      const match = /^from\s+(.+)$/i.exec(line);
      if (match) {
        const value = match[1].trim();
        if (!value.includes("/") && !value.includes("sha256-")) {
          fallback = value;
        }
      }
    }
  }
  return fallback;
}

/** model_info keys vary by family ("llama.context_length", …); find the one
 * ending in ".context_length". */
function contextLengthFrom(
  modelInfo: Record<string, unknown> | undefined,
): number | null {
  if (!modelInfo) {
    return null;
  }
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      return value;
    }
  }
  return null;
}

/** model_info's architecture-family sizing, read under the `general.
 * architecture` prefix. All-or-nothing: a partial ArchParams is worse than
 * none, since the consumer computes a memory figure from it and a wrong
 * figure costs the user a five-minute model load. */
function archParamsFrom(
  modelInfo: Record<string, unknown> | undefined,
): ArchParams | null {
  if (!modelInfo) {
    return null;
  }
  const architecture = modelInfo["general.architecture"];
  if (typeof architecture !== "string") {
    return null;
  }
  const blockCount = modelInfo[`${architecture}.block_count`];
  const headCount = modelInfo[`${architecture}.attention.head_count`];
  const headCountKv = modelInfo[`${architecture}.attention.head_count_kv`];
  const embeddingLength = modelInfo[`${architecture}.embedding_length`];
  if (
    typeof blockCount !== "number" ||
    typeof headCount !== "number" ||
    typeof headCountKv !== "number" ||
    typeof embeddingLength !== "number"
  ) {
    return null;
  }
  const out: ArchParams = {
    architecture,
    blockCount,
    headCount,
    headCountKv,
    embeddingLength,
  };
  // Optional: only trusted when positive numbers, and each stands alone —
  // a model may declare one and not the other.
  const keyLength = modelInfo[`${architecture}.attention.key_length`];
  const valueLength = modelInfo[`${architecture}.attention.value_length`];
  if (typeof keyLength === "number" && keyLength > 0) out.keyLength = keyLength;
  if (typeof valueLength === "number" && valueLength > 0) out.valueLength = valueLength;
  return out;
}

/** POST /api/show's `capabilities`, defensively: anything that isn't an
 * array of strings reads as "none reported". Kept as free strings — Ollama
 * adds capabilities between releases (see pull/catalog.ts). */
function capabilitiesFrom(raw: WireShowResponse | undefined): string[] {
  if (!raw || !Array.isArray(raw.capabilities)) {
    return [];
  }
  return raw.capabilities.filter((c): c is string => typeof c === "string");
}

/**
 * Ollama writes `expires_at: "0001-01-01T00:00:00Z"` — Go's zero time — for a
 * model loaded with an infinite keep_alive. That is not an expiry a UI should
 * ever render, so year 1 (and anything unparseable) becomes null. Otherwise
 * the server's own string is passed through verbatim.
 */
function expiryFrom(value: string | undefined): string | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).getUTCFullYear() <= 1) {
    return null;
  }
  return value;
}

/**
 * The full GET /api/ps readout. Every field past the tag is optional on the
 * wire, so each has a floor: missing size/size_vram are 0 (not NaN), missing
 * context_length/expires_at are null.
 */
function parseRunning(ps: WirePsResponse): RunningModel[] {
  return (ps.models ?? []).map((m) => ({
    tag: m.name ?? m.model ?? "",
    sizeBytes: typeof m.size === "number" ? m.size : 0,
    sizeVramBytes: typeof m.size_vram === "number" ? m.size_vram : 0,
    contextLength: typeof m.context_length === "number" ? m.context_length : null,
    expiresAt: expiryFrom(m.expires_at),
  }));
}

/** RunOptions → Ollama's `options` object. camelCase becomes snake_case and
 * every unset key is dropped — an explicit `undefined` in the JSON body is
 * not the same as absent. Null when nothing is set, so the caller can omit
 * the whole object. */
function wireOptions(options: RunOptions | undefined): Record<string, number> | null {
  if (!options) {
    return null;
  }
  const out: Record<string, number> = {};
  for (const [key, wireKey] of RUN_OPTION_KEYS) {
    const value = options[key];
    if (value !== undefined) {
      out[wireKey] = value;
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * What actually goes on the wire for a message. Only role/content/images —
 * `thinking` is deliberately dropped (Ollama doesn't take reasoning back as
 * context) and `imageThumbs` is a display-only artefact that would bloat
 * every request. Empty `images` is omitted rather than sent as [].
 */
function wireMessage(message: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.images !== undefined && message.images.length > 0) {
    out.images = message.images;
  }
  // Re-encoded to the wire shape rather than passed through: the domain type
  // is `{ name, arguments }`, Ollama's is `{ function: { name, arguments } }`.
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    out.tool_calls = message.toolCalls.map((call) => ({
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.toolName !== undefined && message.toolName !== "") {
    out.tool_name = message.toolName;
  }
  return out;
}

/**
 * `think` has three states on the wire, not two.
 *
 * Ollama declares it `json:"think,omitempty"` on a nil-distinguishable type,
 * so **absent and `false` are different values to the server** — absent means
 * "use the model's default", which for a model Ollama treats as always
 * thinking is *on*. A control labelled "off" that merely omitted the field
 * would therefore not reliably turn reasoning off.
 *
 *   undefined  → omit. Nothing was ever chosen (a model with no thinking
 *                capability never renders the control), so don't opine.
 *   "off"      → `false`. The user explicitly asked for no reasoning, and
 *                only a thinking-capable model can reach this state.
 *   a level    → the string, verbatim.
 */
function wireThink(think: ThinkLevel | undefined): string | boolean | null {
  if (think === undefined) return null;
  return think === "off" ? false : think;
}

/** `message.tool_calls`, defensively: anything that isn't an array yields
 * no calls at all. A member missing a string `function.name` is dropped
 * rather than coerced into a fake call; a missing/non-object `arguments`
 * defaults to `{}`. Ollama returns `arguments` already parsed — never
 * `JSON.parse` it here. */
function toolCallsFrom(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ToolCall[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const fn = (entry as { function?: unknown }).function;
    if (typeof fn !== "object" || fn === null) {
      continue;
    }
    const name = (fn as { name?: unknown }).name;
    if (typeof name !== "string") {
      continue;
    }
    const args = (fn as { arguments?: unknown }).arguments;
    const isPlainObject = typeof args === "object" && args !== null && !Array.isArray(args);
    out.push({
      name,
      arguments: isPlainObject ? (args as Record<string, unknown>) : {},
    });
  }
  return out;
}

/* ── Factory ────────────────────────────────────────────────────────────── */

export function createClient(baseUrl: string = DEFAULT_BASE_URL): OllamaClient {
  const root = baseUrl.replace(/\/+$/, "");
  const url = (path: string) => `${root}${path}`;

  async function getJson<T>(path: string): Promise<T> {
    const res = await requireOk(await fetch(url(path)), path);
    return (await res.json()) as T;
  }

  async function send(
    method: "POST" | "DELETE",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const res = await fetch(url(path), {
      method,
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      signal,
    });
    return requireOk(res, path);
  }

  async function showRaw(tag: string): Promise<WireShowResponse> {
    const res = await send("POST", "/api/show", { model: tag });
    return (await res.json()) as WireShowResponse;
  }

  /**
   * The models from /api/tags, plus the parent each one declares, plus the
   * full /api/ps readout.
   *
   * `details.parent_model` is Ollama's own answer to "was this built FROM
   * another local model?" — it names the exact tag `ollama create` used. It's
   * kept out of Model (a tag's own facts) and handed to listGroups, which is
   * where derivation matters; unresolvable parents don't survive that far.
   *
   * `running` rides along because /api/ps is already being fetched here for
   * `isLoaded`. The 5s poll reads the runtime pane's numbers out of this same
   * response rather than asking again (SPEC §5.1).
   */
  async function fetchModels(): Promise<{
    models: Model[];
    parents: Map<string, string>;
    running: RunningModel[];
  }> {
    const [tags, ps] = await Promise.all([
      getJson<WireTagsResponse>("/api/tags"),
      getJson<WirePsResponse>("/api/ps"),
    ]);
    const running = parseRunning(ps);
    const loaded = new Set(running.map((m) => normalizeTag(m.tag)));
    const parents = new Map<string, string>();
    const models = (tags.models ?? []).map((m) => {
      const tag = m.name ?? m.model ?? "";
      const parent = m.details?.parent_model ?? "";
      if (parent.trim() !== "") {
        parents.set(tag, parent.trim());
      }
      return {
        tag,
        family: m.details?.family ?? "",
        parameterSize: m.details?.parameter_size ?? "",
        quantization: m.details?.quantization_level ?? "",
        sizeBytes: m.size ?? 0,
        contextLength: null,
        isLoaded: loaded.has(normalizeTag(tag)),
        base: null,
        isVariant: false,
        modifiedAt: m.modified_at ?? "",
        // /api/tags doesn't carry capabilities; only the /api/show sweep in
        // listGroups can fill these in.
        capabilities: [],
      };
    });
    return { models, parents, running };
  }

  async function listModels(): Promise<Model[]> {
    return (await fetchModels()).models;
  }

  async function listModelsWithRunning(): Promise<ModelSnapshot> {
    const { models, running } = await fetchModels();
    return { models, running };
  }

  return {
    async version(): Promise<ServerStatus> {
      try {
        const res = await fetch(url("/api/version"), {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) {
          return { connected: false, version: null };
        }
        const body = (await res.json()) as { version?: string };
        return { connected: true, version: body.version ?? null };
      } catch {
        return { connected: false, version: null };
      }
    },

    listModels,

    listModelsWithRunning,

    async listRunning(): Promise<RunningModel[]> {
      return parseRunning(await getJson<WirePsResponse>("/api/ps"));
    },

    async listGroups(): Promise<ModelGroup[]> {
      const { models, parents } = await fetchModels();
      const byNorm = new Map<string, Model>();
      for (const m of models) {
        byNorm.set(normalizeTag(m.tag), m);
      }
      // One show() per model per call, fetched concurrently and cached here.
      const shows = new Map<string, WireShowResponse>();
      await Promise.all(
        models.map(async (m) => {
          shows.set(m.tag, await showRaw(m.tag));
        }),
      );
      const resolved: Model[] = models.map((m) => {
        const raw = shows.get(m.tag);
        // The declared parent is authoritative; the Modelfile scan is the
        // fallback for servers that don't report one. A parent naming a model
        // that isn't installed (deleted since, or pulled ready-made) leaves
        // this tag a base — there's nothing here to nest it under.
        const candidates = [
          parents.get(m.tag) ?? null,
          raw?.modelfile ? parseFrom(raw.modelfile) : null,
        ];
        let base: string | null = null;
        for (const from of candidates) {
          if (from === null) continue;
          const target = byNorm.get(normalizeTag(from));
          if (target && target.tag !== m.tag) {
            base = target.tag;
            break;
          }
        }
        return {
          ...m,
          base,
          isVariant: base !== null,
          contextLength: contextLengthFrom(raw?.model_info),
          // Same cached /api/show response the base resolution above reads —
          // capabilities cost no extra request.
          capabilities: capabilitiesFrom(raw),
        };
      });
      const groups = new Map<string, ModelGroup>();
      for (const m of resolved) {
        if (!m.isVariant) {
          groups.set(m.tag, { base: m, variants: [] });
        }
      }
      for (const m of resolved) {
        if (!m.isVariant) {
          continue;
        }
        const group = m.base !== null ? groups.get(m.base) : undefined;
        if (group) {
          group.variants.push(m);
        } else {
          // Base isn't a group of its own (e.g. variant-of-a-variant):
          // the model stands alone as its own base.
          groups.set(m.tag, { base: m, variants: [] });
        }
      }
      return [...groups.values()];
    },

    async show(tag: string): Promise<ModelDetail> {
      const raw = await showRaw(tag);
      return {
        tag,
        modelfile: raw.modelfile ?? "",
        parameters: raw.parameters ?? "",
        template: raw.template ?? "",
        system: raw.system ?? "",
        details: {
          family: raw.details?.family ?? "",
          parameterSize: raw.details?.parameter_size ?? "",
          quantizationLevel: raw.details?.quantization_level ?? "",
        },
        contextLength: contextLengthFrom(raw.model_info),
        capabilities: capabilitiesFrom(raw),
        archParams: archParamsFrom(raw.model_info),
      };
    },

    async load(
      tag: string,
      keepAlive: KeepAlive,
      signal?: AbortSignal,
      numCtx?: number,
      numGpu?: number,
    ): Promise<void> {
      const body: Record<string, unknown> = {
        model: tag,
        prompt: "",
        keep_alive: keepAlive,
        stream: false,
      };
      // Omitted rather than sent as null when unset, matching wireOptions —
      // an explicit num_ctx overrides the Modelfile's PARAMETER, so sending
      // one the user didn't choose would silently override their own file.
      const options: Record<string, number> = {};
      if (typeof numCtx === "number" && numCtx > 0) {
        options.num_ctx = numCtx;
      }
      // Unlike num_ctx, 0 is a real, distinct instruction here ("no layers on
      // the GPU") — so the guard is `typeof`, not truthiness, and the caller
      // is trusted for range (0..blockCount is the UI's job to enforce).
      if (typeof numGpu === "number") {
        options.num_gpu = numGpu;
      }
      if (Object.keys(options).length > 0) {
        body.options = options;
      }
      const res = await send("POST", "/api/generate", body, signal);
      await res.text();
    },

    async unload(tag: string): Promise<void> {
      const res = await send("POST", "/api/generate", {
        model: tag,
        prompt: "",
        keep_alive: 0,
        stream: false,
      });
      await res.text();
    },

    async *chat(
      tag: string,
      messages: ChatMessage[],
      opts: {
        keepAlive: KeepAlive;
        signal?: AbortSignal;
        think?: ThinkLevel;
        options?: RunOptions;
        tools?: unknown[];
      },
    ): AsyncIterable<ChatChunk> {
      const requestBody: Record<string, unknown> = {
        model: tag,
        messages: messages.map(wireMessage),
        stream: true,
        keep_alive: opts.keepAlive,
      };
      const think = wireThink(opts.think);
      if (think !== null) {
        requestBody.think = think;
      }
      const options = wireOptions(opts.options);
      if (options !== null) {
        requestBody.options = options;
      }
      if (opts.tools !== undefined && opts.tools.length > 0) {
        requestBody.tools = opts.tools;
      }
      const res = await send("POST", "/api/chat", requestBody, opts.signal);
      const body = requireBody(res, "/api/chat");
      let sawDone = false;
      for await (const line of ndjson<WireChatLine>(body, opts.signal)) {
        if (typeof line.error === "string") {
          throw new Error(line.error);
        }
        const done = line.done === true;
        if (done) sawDone = true;
        const chunk: ChatChunk = {
          content: line.message?.content ?? "",
          done,
        };
        // Reasoning arrives in its own field and stays there — folding it
        // into `content` would put the model's scratchpad in the transcript.
        const thinking = line.message?.thinking;
        if (typeof thinking === "string" && thinking !== "") {
          chunk.thinking = thinking;
        }
        const toolCalls = toolCallsFrom(line.message?.tool_calls);
        if (toolCalls.length > 0) {
          chunk.toolCalls = toolCalls;
        }
        if (
          done &&
          typeof line.eval_count === "number" &&
          typeof line.eval_duration === "number"
        ) {
          const stats: NonNullable<ChatChunk["stats"]> = {
            evalCount: line.eval_count,
            evalDurationNs: line.eval_duration,
          };
          // The prefill/load/total breakdown is newer than eval_*; a server
          // that omits it leaves these absent rather than 0.
          if (typeof line.prompt_eval_count === "number") {
            stats.promptEvalCount = line.prompt_eval_count;
          }
          if (typeof line.prompt_eval_duration === "number") {
            stats.promptEvalDurationNs = line.prompt_eval_duration;
          }
          if (typeof line.load_duration === "number") {
            stats.loadDurationNs = line.load_duration;
          }
          if (typeof line.total_duration === "number") {
            stats.totalDurationNs = line.total_duration;
          }
          chunk.stats = stats;
        }
        yield chunk;
      }
      if (!sawDone) {
        throw new Error("chat stream ended without a done message (connection interrupted?)");
      }
    },

    async *create(
      name: string,
      request: CreateRequest,
      signal?: AbortSignal,
    ): AsyncIterable<CreateStatus> {
      // Structured body first (current Ollama); legacy `modelfile` string as
      // the fallback for older servers (SPEC §9 version skew).
      const structured: Record<string, unknown> = {
        model: name,
        from: request.from,
        stream: true,
      };
      if (request.system !== undefined) structured.system = request.system;
      if (request.template !== undefined) structured.template = request.template;
      if (request.license !== undefined) structured.license = request.license;
      if (request.messages !== undefined) structured.messages = request.messages;
      if (request.parameters !== undefined) structured.parameters = request.parameters;
      if (request.quantize !== undefined) structured.quantize = request.quantize;

      let res: Response;
      try {
        res = await send("POST", "/api/create", structured, signal);
      } catch (err) {
        // A 400-class rejection is ambiguous: an old server that predates
        // the structured form, OR a current server rejecting the content
        // for a real reason. Retry once with the legacy body — a genuinely
        // old server accepts it — but if the retry ALSO fails, surface the
        // ORIGINAL structured error: on a current server it is the accurate
        // one, and the legacy failure ("modelfile is unsupported") would
        // only mislead. Anything non-400 (404, network) propagates as-is.
        const message = err instanceof Error ? err.message : "";
        if (!/\((400|422)\)/.test(message)) {
          throw err;
        }
        // The legacy `modelfile` string has no way to say "quantize to
        // q4_K_M". Falling back would quietly create an unquantised model
        // under the name the user asked to quantise — worse than failing.
        if (request.quantize !== undefined) {
          throw err;
        }
        try {
          res = await send(
            "POST",
            "/api/create",
            { model: name, modelfile: request.rawModelfile, stream: true },
            signal,
          );
        } catch {
          throw err;
        }
      }
      const body = requireBody(res, "/api/create");
      let sawSuccess = false;
      for await (const line of ndjson<WireStreamLine>(body, signal)) {
        if (typeof line.error === "string") {
          throw new Error(line.error);
        }
        if (line.status === "success") sawSuccess = true;
        yield { status: line.status ?? "" };
      }
      if (!sawSuccess) {
        throw new Error("create stream ended without a success status (connection interrupted?)");
      }
    },

    async *pull(
      tag: string,
      signal?: AbortSignal,
    ): AsyncIterable<PullProgress> {
      const res = await send(
        "POST",
        "/api/pull",
        { model: tag, stream: true },
        signal,
      );
      const body = requireBody(res, "/api/pull");
      let sawSuccess = false;
      for await (const line of ndjson<WireStreamLine>(body, signal)) {
        if (typeof line.error === "string") {
          throw new Error(line.error);
        }
        if (line.status === "success") sawSuccess = true;
        const progress: PullProgress = { status: line.status ?? "" };
        if (typeof line.digest === "string") {
          progress.digest = line.digest;
        }
        if (typeof line.total === "number") {
          progress.total = line.total;
        }
        if (typeof line.completed === "number") {
          progress.completed = line.completed;
        }
        yield progress;
      }
      if (!sawSuccess) {
        throw new Error("pull stream ended without a success status (connection interrupted?)");
      }
    },

    async deleteModel(tag: string): Promise<void> {
      await send("DELETE", "/api/delete", { model: tag });
    },

    async copy(source: string, destination: string): Promise<void> {
      await send("POST", "/api/copy", { source, destination });
    },
  };
}
