/**
 * Hand-written fake of OllamaClient (SPEC.md §6-§7 / api/types.ts) for UI
 * tests. Never imports src/api/client.ts — that's the real HTTP
 * implementation another agent owns; tests only need the shape.
 */
import type {
  ChatChunk,
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
  version?: string;
  /** version() rejects, simulating an unreachable server. */
  failVersion?: boolean;
}

export class FakeClient implements OllamaClient {
  models: Model[];
  connected: boolean;
  versionString: string;
  failVersion: boolean;
  loadCalls: { tag: string; keepAlive: KeepAlive }[] = [];

  constructor(options: FakeClientOptions = {}) {
    this.models = options.models ?? [];
    this.connected = options.connected ?? true;
    this.versionString = options.version ?? "0.5.4";
    this.failVersion = options.failVersion ?? false;
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
    this.loadCalls.push({ tag, keepAlive });
    this.models = this.models.map((m) => ({ ...m, isLoaded: m.tag === tag }));
  }

  async unload(tag: string): Promise<void> {
    this.models = this.models.map((m) => (m.tag === tag ? { ...m, isLoaded: false } : m));
  }

  async *chat(): AsyncIterable<ChatChunk> {
    yield { content: "", done: true };
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
