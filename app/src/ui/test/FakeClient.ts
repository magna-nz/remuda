/**
 * Hand-written fake of OllamaClient (SPEC.md §6-§7 / api/types.ts) for UI
 * tests. Never imports src/api/client.ts — that's the real HTTP
 * implementation another agent owns; tests only need the shape.
 */
import type {
  ChatChunk,
  ChatMessage,
  CreateStatus,
  KeepAlive,
  Model,
  ModelDetail,
  ModelGroup,
  OllamaClient,
  PullProgress,
  ServerStatus,
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
  /**
   * Scripted chat replies: chat() yields these chunks in order (stopping
   * after a done chunk), checking the abort signal between chunks. Without
   * this, chat() streams whatever the test pushes via emitChat().
   */
  chatChunks?: ChatChunk[];
  /** chat() throws with this message before yielding anything. */
  failChat?: string;
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
  loadCalls: { tag: string; keepAlive: KeepAlive }[] = [];
  chatChunks: ChatChunk[] | undefined;
  failChat: string | undefined;
  chatCalls: { tag: string; messages: ChatMessage[]; keepAlive: KeepAlive }[] = [];
  private chatQueue: ChatChunk[] = [];
  private chatWaiter: ((chunk: ChatChunk) => void) | null = null;

  constructor(options: FakeClientOptions = {}) {
    this.models = options.models ?? [];
    this.connected = options.connected ?? true;
    this.versionString = options.version === undefined ? "0.5.4" : options.version;
    this.failVersion = options.failVersion ?? false;
    this.failLoad = options.failLoad;
    this.chatChunks = options.chatChunks;
    this.failChat = options.failChat;
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

  async listGroups(): Promise<ModelGroup[]> {
    const bases = this.models.filter((m) => !m.isVariant);
    return bases.map((base) => ({
      base,
      variants: this.models.filter((m) => m.isVariant && m.base === base.tag),
    }));
  }

  async show(tag: string): Promise<ModelDetail> {
    const model = this.models.find((m) => m.tag === tag);
    return {
      tag,
      modelfile: "",
      parameters: "",
      template: "",
      system: "",
      details: {
        family: model?.family ?? "unknown",
        parameterSize: model?.parameterSize ?? "",
        quantizationLevel: model?.quantization ?? "",
      },
      contextLength: model?.contextLength ?? null,
    };
  }

  async load(tag: string, keepAlive: KeepAlive): Promise<void> {
    if (this.failLoad !== undefined) {
      throw new Error(this.failLoad);
    }
    this.loadCalls.push({ tag, keepAlive });
    this.models = this.models.map((m) => ({ ...m, isLoaded: m.tag === tag }));
  }

  async unload(tag: string): Promise<void> {
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
    opts: { keepAlive: KeepAlive; signal?: AbortSignal },
  ): AsyncIterable<ChatChunk> {
    this.chatCalls.push({ tag, messages: messages.map((m) => ({ ...m })), keepAlive: opts.keepAlive });
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

  async *create(): AsyncIterable<CreateStatus> {
    yield { status: "success" };
  }

  async *pull(): AsyncIterable<PullProgress> {
    yield { status: "success" };
  }

  async deleteModel(): Promise<void> {}

  async copy(): Promise<void> {}
}
