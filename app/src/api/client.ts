/**
 * Ollama HTTP client (SPEC.md §3, §6, §7). Implements the frozen contract
 * in types.ts against Ollama's local API. All requests go to the configured
 * base URL, which defaults to loopback.
 */
import type {
  ChatChunk,
  ChatMessage,
  CreateRequest,
  CreateStatus,
  KeepAlive,
  Model,
  ModelDetail,
  ModelGroup,
  OllamaClient,
  PullProgress,
  ServerStatus,
} from "./types";
import { DEFAULT_BASE_URL } from "./types";
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
  models?: Array<{ name?: string; model?: string }>;
}

interface WireShowResponse {
  modelfile?: string;
  parameters?: string;
  template?: string;
  system?: string;
  details?: WireDetails;
  model_info?: Record<string, unknown>;
}

interface WireChatLine {
  message?: { content?: string };
  done?: boolean;
  eval_count?: number;
  eval_duration?: number;
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
   * The models from /api/tags, plus the parent each one declares.
   *
   * `details.parent_model` is Ollama's own answer to "was this built FROM
   * another local model?" — it names the exact tag `ollama create` used. It's
   * kept out of Model (a tag's own facts) and handed to listGroups, which is
   * where derivation matters; unresolvable parents don't survive that far.
   */
  async function fetchModels(): Promise<{ models: Model[]; parents: Map<string, string> }> {
    const [tags, ps] = await Promise.all([
      getJson<WireTagsResponse>("/api/tags"),
      getJson<WirePsResponse>("/api/ps"),
    ]);
    const loaded = new Set(
      (ps.models ?? []).map((m) => normalizeTag(m.name ?? m.model ?? "")),
    );
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
      };
    });
    return { models, parents };
  }

  async function listModels(): Promise<Model[]> {
    return (await fetchModels()).models;
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
      };
    },

    async load(
      tag: string,
      keepAlive: KeepAlive,
      signal?: AbortSignal,
    ): Promise<void> {
      const res = await send(
        "POST",
        "/api/generate",
        { model: tag, prompt: "", keep_alive: keepAlive, stream: false },
        signal,
      );
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
      opts: { keepAlive: KeepAlive; signal?: AbortSignal },
    ): AsyncIterable<ChatChunk> {
      const res = await send(
        "POST",
        "/api/chat",
        {
          model: tag,
          messages,
          stream: true,
          keep_alive: opts.keepAlive,
        },
        opts.signal,
      );
      const body = requireBody(res, "/api/chat");
      for await (const line of ndjson<WireChatLine>(body, opts.signal)) {
        if (typeof line.error === "string") {
          throw new Error(line.error);
        }
        const done = line.done === true;
        const chunk: ChatChunk = {
          content: line.message?.content ?? "",
          done,
        };
        if (
          done &&
          typeof line.eval_count === "number" &&
          typeof line.eval_duration === "number"
        ) {
          chunk.stats = {
            evalCount: line.eval_count,
            evalDurationNs: line.eval_duration,
          };
        }
        yield chunk;
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
      for await (const line of ndjson<WireStreamLine>(body, signal)) {
        if (typeof line.error === "string") {
          throw new Error(line.error);
        }
        yield { status: line.status ?? "" };
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
      for await (const line of ndjson<WireStreamLine>(body, signal)) {
        if (typeof line.error === "string") {
          throw new Error(line.error);
        }
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
    },

    async deleteModel(tag: string): Promise<void> {
      await send("DELETE", "/api/delete", { model: tag });
    },

    async copy(source: string, destination: string): Promise<void> {
      await send("POST", "/api/copy", { source, destination });
    },
  };
}
