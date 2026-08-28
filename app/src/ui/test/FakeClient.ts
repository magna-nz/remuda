/**
 * Hand-written fake of OllamaClient (SPEC.md §6-§7 / api/types.ts) for UI
 * tests. Never imports src/api/client.ts — that's the real HTTP
 * implementation another agent owns; tests only need the shape.
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
  ModelSnapshot,
  OllamaClient,
  PullProgress,
  RunOptions,
  RunningModel,
  ServerStatus,
  ThinkLevel,
} from "../../api/types";

/** Fills in reasonable defaults so fixtures only spell out what a test cares about. */
export function makeModel(overrides: Partial<Model> & { tag: string }): Model {
  return {
    family: "llama",
    parameterSize: "8B",
    quantization: "Q4_K_M",
    sizeBytes: 4_700_000_000,
    contextLength: 8192,
    isLoaded: false,
    base: null,
    isVariant: false,
    modifiedAt: "2026-01-01T00:00:00Z",
    capabilities: [],
    ...overrides,
  };
}

export interface FakeClientOptions {
  models?: Model[];
  connected?: boolean;
  /** null simulates a connected server whose /api/version omits a version string. */
  version?: string | null;
  /** version() rejects, simulating an unreachable server. */
  failVersion?: boolean;
  /** load() rejects with this message, simulating a failed load request. */
  failLoad?: string;
  /** unload() rejects with this message, simulating a failed eject (SPEC §9). */
  failUnload?: string;
  /**
   * Scripted chat replies: chat() yields these chunks in order (stopping
   * after a done chunk), checking the abort signal between chunks. Without
   * this, chat() streams whatever the test pushes via emitChat().
   */
  chatChunks?: ChatChunk[];
  /** chat() throws with this message before yielding anything. */
  failChat?: string;
  /**
   * show() returns this raw Modelfile text for any tag (M3 editor tests).
   * Per-tag overrides can be set afterwards via `modelfileByTag`.
   */
  modelfile?: string;
  /** create() yields these statuses in order; defaults to a single "success". */
  createStatuses?: CreateStatus[];
  /** create() throws with this message before yielding anything (SPEC §9). */
  failCreate?: string;
  /**
   * Scripted pull events: pull() yields these in order, checking the abort
   * signal between events. Without this, pull() streams whatever the test
   * pushes via emitPull() (live/unscripted, mirrors chatChunks/emitChat).
   */
  pullEvents?: PullProgress[];
  /**
   * pull() throws with this message (SPEC §9). With `pullEvents` set, the
   * scripted events yield first, then the throw — so a test can show partial
   * layer progress before the failure. Without `pullEvents`, it throws
   * immediately, before yielding anything.
   */
  failPull?: string;
  /** listGroups() rejects, simulating a failing /api/show inside the sweep. */
  failListGroups?: string;
  /**
   * Scripted GET /api/ps readout. Without this, listRunning() derives one
   * from `models` (every isLoaded model, no VRAM split, no expiry) so
   * load()/chat() keep it in sync automatically. Set it to pin exact
   * SIZE/PROCESSOR/CONTEXT/UNTIL numbers — it then wins over `models`, and
   * a later load() will NOT change it.
   */
  running?: RunningModel[];
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export class FakeClient implements OllamaClient {
  models: Model[];
  connected: boolean;
  versionString: string | null;
  failVersion: boolean;
  failLoad: string | undefined;
  failUnload: string | undefined;
  loadCalls: { tag: string; keepAlive: KeepAlive }[] = [];
  chatChunks: ChatChunk[] | undefined;
  failChat: string | undefined;
  /** Every chat() call, including the think level and run options it carried. */
  chatCalls: {
    tag: string;
    messages: ChatMessage[];
    keepAlive: KeepAlive;
    think?: ThinkLevel;
    options?: RunOptions;
  }[] = [];
  private chatQueue: ChatChunk[] = [];
  private chatWaiter: ((chunk: ChatChunk) => void) | null = null;

  /** Raw Modelfile text show() returns; keyed by tag, falling back to `modelfile`. */
  modelfile: string;
  modelfileByTag: Record<string, string> = {};
  showCalls: string[] = [];
  createStatuses: CreateStatus[];
  failCreate: string | undefined;
  createCalls: { name: string; request: CreateRequest }[] = [];
  unloadCalls: string[] = [];

  pullEvents: PullProgress[] | undefined;
  failPull: string | undefined;
  pullCalls: string[] = [];
  deleteCalls: string[] = [];
  private pullQueue: PullProgress[] = [];
  private pullWaiter: ((event: PullProgress) => void) | null = null;

  constructor(options: FakeClientOptions = {}) {
    this.models = options.models ?? [];
    this.connected = options.connected ?? true;
    this.versionString = options.version === undefined ? "0.5.4" : options.version;
    this.failVersion = options.failVersion ?? false;
    this.failLoad = options.failLoad;
    this.failUnload = options.failUnload;
    this.chatChunks = options.chatChunks;
    this.failChat = options.failChat;
    this.modelfile = options.modelfile ?? "";
    this.createStatuses = options.createStatuses ?? [{ status: "success" }];
    this.failCreate = options.failCreate;
    this.pullEvents = options.pullEvents;
    this.failPull = options.failPull;
    this.failListGroups = options.failListGroups;
    this.running = options.running;
  }

  async version(): Promise<ServerStatus> {
    if (this.failVersion) {
      throw new Error("fake: server unreachable");
    }
    return { connected: this.connected, version: this.connected ? this.versionString : null };
  }

  async listModels(): Promise<Model[]> {
    return this.models;
  }

  /** Scripted /api/ps; undefined derives it from `models`. */
  running: RunningModel[] | undefined;
  /** Counts standalone /api/ps reads — the poll must never need one. */
  listRunningCalls = 0;

  async listRunning(): Promise<RunningModel[]> {
    this.listRunningCalls += 1;
    return this.runningNow();
  }

  /**
   * The whole point of this method on the real client: /api/tags and /api/ps
   * in ONE trip. It deliberately does not bump listRunningCalls, so a test
   * can assert the poll adds no standalone /api/ps.
   */
  async listModelsWithRunning(): Promise<ModelSnapshot> {
    return { models: this.models, running: this.runningNow() };
  }

  private runningNow(): RunningModel[] {
    // A scripted readout supplies the numbers, but residency still comes from
    // the model list — otherwise an ejected model keeps reporting itself as
    // resident and the tray never empties.
    if (this.running !== undefined) {
      const resident = new Set(this.models.filter((m) => m.isLoaded).map((m) => m.tag));
      return this.running.filter((r) => resident.has(r.tag));
    }
    return this.models
      .filter((m) => m.isLoaded)
      .map((m) => ({
        tag: m.tag,
        sizeBytes: m.sizeBytes,
        sizeVramBytes: m.sizeBytes,
        contextLength: m.contextLength,
        expiresAt: null,
      }));
  }

  /** Counts the expensive /api/show sweep, so tests can assert it's rare. */
  listGroupsCalls = 0;
  /** listGroups() rejects with this message (simulates a failing /api/show). */
  failListGroups: string | undefined;
  /** listGroups() takes this long, so a test can outrun it with the poll. */
  listGroupsDelayMs = 0;

  async listGroups(): Promise<ModelGroup[]> {
    this.listGroupsCalls += 1;
    if (this.listGroupsDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.listGroupsDelayMs));
    }
    if (this.failListGroups !== undefined) {
      throw new Error(this.failListGroups);
    }
    const bases = this.models.filter((m) => !m.isVariant);
    const groups = bases.map((base) => ({
      base,
      variants: this.models.filter((m) => m.isVariant && m.base === base.tag),
    }));
    // A variant whose base isn't installed (deleted since, or never present)
    // still has to appear. The real client resolves `base` against the
    // installed set, so an unresolvable parent leaves the tag a base in its
    // own right — mirror that here, rather than dropping the model. Dropping
    // it also made the provider's signature permanently unmatchable, which
    // presents as a mysterious /api/show sweep storm rather than a failure.
    const grouped = new Set(groups.flatMap((g) => [g.base.tag, ...g.variants.map((v) => v.tag)]));
    for (const orphan of this.models.filter((m) => !grouped.has(m.tag))) {
      groups.push({ base: { ...orphan, base: null, isVariant: false }, variants: [] });
    }
    return groups;
  }

  async show(tag: string): Promise<ModelDetail> {
    this.showCalls.push(tag);
    const model = this.models.find((m) => m.tag === tag);
    return {
      tag,
      modelfile: this.modelfileByTag[tag] ?? this.modelfile,
      parameters: "",
      template: "",
      system: "",
      details: {
        family: model?.family ?? "unknown",
        parameterSize: model?.parameterSize ?? "",
        quantizationLevel: model?.quantization ?? "",
      },
      contextLength: model?.contextLength ?? null,
      capabilities: model?.capabilities ?? [],
    };
  }

  async load(tag: string, keepAlive: KeepAlive): Promise<void> {
    if (this.failLoad !== undefined) {
      throw new Error(this.failLoad);
    }
    this.loadCalls.push({ tag, keepAlive });
    // Additive, like Ollama: loading a model doesn't evict the others until
    // OLLAMA_MAX_LOADED_MODELS forces it.
    this.models = this.models.map((m) => (m.tag === tag ? { ...m, isLoaded: true } : m));
  }

  async unload(tag: string): Promise<void> {
    if (this.failUnload !== undefined) {
      throw new Error(this.failUnload);
    }
    this.unloadCalls.push(tag);
    this.models = this.models.map((m) => (m.tag === tag ? { ...m, isLoaded: false } : m));
  }

  /** Push a chunk into a live (unscripted) chat stream. */
  emitChat(chunk: ChatChunk): void {
    if (this.chatWaiter) {
      const waiter = this.chatWaiter;
      this.chatWaiter = null;
      waiter(chunk);
    } else {
      this.chatQueue.push(chunk);
    }
  }

  private nextChatChunk(signal?: AbortSignal): Promise<ChatChunk> {
    const queued = this.chatQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          this.chatWaiter = null;
          reject(abortError());
        },
        { once: true },
      );
      this.chatWaiter = resolve;
    });
  }

  async *chat(
    tag: string,
    messages: ChatMessage[],
    opts: {
      keepAlive: KeepAlive;
      signal?: AbortSignal;
      think?: ThinkLevel;
      options?: RunOptions;
    },
  ): AsyncIterable<ChatChunk> {
    this.chatCalls.push({
      tag,
      messages: messages.map((m) => ({ ...m })),
      keepAlive: opts.keepAlive,
      think: opts.think,
      options: opts.options === undefined ? undefined : { ...opts.options },
    });
    if (this.failChat !== undefined) {
      throw new Error(this.failChat);
    }
    const finish = () => {
      // Ollama loads the chatted model on demand; mirror that in /api/ps.
      this.models = this.models.map((m) => ({ ...m, isLoaded: m.tag === tag }));
    };
    if (this.chatChunks !== undefined) {
      for (const chunk of this.chatChunks) {
        await Promise.resolve();
        if (opts.signal?.aborted) throw abortError();
        yield chunk;
        if (chunk.done) {
          finish();
          return;
        }
      }
      finish();
      return;
    }
    for (;;) {
      const chunk = await this.nextChatChunk(opts.signal);
      yield chunk;
      if (chunk.done) {
        finish();
        return;
      }
    }
  }

  async *create(name: string, request: CreateRequest): AsyncIterable<CreateStatus> {
    this.createCalls.push({ name, request });
    if (this.failCreate !== undefined) {
      throw new Error(this.failCreate);
    }
    for (const status of this.createStatuses) {
      yield status;
    }
  }

  /** Push an event into a live (unscripted) pull stream. */
  emitPull(event: PullProgress): void {
    if (this.pullWaiter) {
      const waiter = this.pullWaiter;
      this.pullWaiter = null;
      waiter(event);
    } else {
      this.pullQueue.push(event);
    }
  }

  private nextPullEvent(signal?: AbortSignal): Promise<PullProgress> {
    const queued = this.pullQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          this.pullWaiter = null;
          reject(abortError());
        },
        { once: true },
      );
      this.pullWaiter = resolve;
    });
  }

  async *pull(tag: string, signal?: AbortSignal): AsyncIterable<PullProgress> {
    this.pullCalls.push(tag);
    if (this.pullEvents !== undefined) {
      if (signal?.aborted) throw abortError();
      for (const event of this.pullEvents) {
        await Promise.resolve();
        if (signal?.aborted) throw abortError();
        yield event;
      }
      if (this.failPull !== undefined) {
        throw new Error(this.failPull);
      }
      return;
    }
    if (this.failPull !== undefined) {
      throw new Error(this.failPull);
    }
    for (;;) {
      const event = await this.nextPullEvent(signal);
      yield event;
      if (event.status === "success") return;
    }
  }

  async deleteModel(tag: string): Promise<void> {
    this.deleteCalls.push(tag);
    this.models = this.models.filter((m) => m.tag !== tag);
  }

  async copy(): Promise<void> {}
}
