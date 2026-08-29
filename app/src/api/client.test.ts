import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./client";
import { DEFAULT_BASE_URL } from "./types";
import type { ChatChunk, ChatMessage } from "./types";

/* ── fetch stubbing helpers (no live server) ────────────────────────────── */

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** A minimal Response-shaped object covering what client.ts touches. */
function jsonResponse(data: unknown, status = 200): Response {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
    body: streamOf([text]),
  } as unknown as Response;
}

function streamResponse(chunks: string[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => chunks.join(""),
    json: async () => JSON.parse(chunks.join("")) as unknown,
    body: streamOf(chunks),
  } as unknown as Response;
}

type FetchStub = ReturnType<typeof vi.fn<typeof fetch>>;

/** Stub global fetch, routing by URL path. Unrouted paths fail the test. */
function stubFetch(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
): FetchStub {
  const stub = vi.fn<typeof fetch>(async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href).pathname;
    const route = routes[path];
    if (!route) {
      throw new Error(`unrouted fetch in test: ${href}`);
    }
    return route(init);
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) {
    out.push(value);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── version() ──────────────────────────────────────────────────────────── */

describe("version", () => {
  it("reports connected with the server version", async () => {
    const stub = stubFetch({
      "/api/version": () => jsonResponse({ version: "0.5.4" }),
    });
    const status = await createClient().version();
    expect(status).toEqual({ connected: true, version: "0.5.4" });
    expect(String(stub.mock.calls[0][0])).toBe(
      `${DEFAULT_BASE_URL}/api/version`,
    );
  });

  it("reports disconnected on a network error and never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(createClient().version()).resolves.toEqual({
      connected: false,
      version: null,
    });
  });

  it("reports disconnected on a non-2xx response", async () => {
    stubFetch({ "/api/version": () => jsonResponse({}, 502) });
    await expect(createClient().version()).resolves.toEqual({
      connected: false,
      version: null,
    });
  });
});

/* ── listModels() ───────────────────────────────────────────────────────── */

const TAGS = {
  models: [
    {
      name: "llama3.1:8b",
      size: 4_700_000_000,
      modified_at: "2026-08-01T10:00:00Z",
      details: {
        family: "llama",
        parameter_size: "8.0B",
        quantization_level: "Q4_K_M",
      },
    },
    {
      name: "gemma2:9b",
      size: 5_400_000_000,
      modified_at: "2026-07-15T09:00:00Z",
      details: {
        family: "gemma2",
        parameter_size: "9.2B",
        quantization_level: "Q4_0",
      },
    },
  ],
};

describe("listModels", () => {
  it("merges /api/tags fields with loaded state from /api/ps", async () => {
    stubFetch({
      "/api/tags": () => jsonResponse(TAGS),
      "/api/ps": () => jsonResponse({ models: [{ name: "llama3.1:8b" }] }),
    });
    const models = await createClient().listModels();
    expect(models).toEqual([
      {
        tag: "llama3.1:8b",
        family: "llama",
        parameterSize: "8.0B",
        quantization: "Q4_K_M",
        sizeBytes: 4_700_000_000,
        contextLength: null,
        isLoaded: true,
        base: null,
        isVariant: false,
        modifiedAt: "2026-08-01T10:00:00Z",
        // /api/tags carries no capabilities; only the listGroups sweep can.
        capabilities: [],
      },
      {
        tag: "gemma2:9b",
        family: "gemma2",
        parameterSize: "9.2B",
        quantization: "Q4_0",
        sizeBytes: 5_400_000_000,
        contextLength: null,
        isLoaded: false,
        base: null,
        isVariant: false,
        modifiedAt: "2026-07-15T09:00:00Z",
        capabilities: [],
      },
    ]);
  });
});

/* ── listRunning() / listModelsWithRunning() ────────────────────────────── */

describe("listRunning", () => {
  it("maps the full /api/ps readout", async () => {
    stubFetch({
      "/api/ps": () =>
        jsonResponse({
          models: [
            {
              name: "llama3.1:8b",
              size: 6_000_000_000,
              size_vram: 4_500_000_000,
              context_length: 8192,
              expires_at: "2026-08-26T12:05:00Z",
            },
          ],
        }),
    });
    await expect(createClient().listRunning()).resolves.toEqual([
      {
        tag: "llama3.1:8b",
        sizeBytes: 6_000_000_000,
        sizeVramBytes: 4_500_000_000,
        contextLength: 8192,
        expiresAt: "2026-08-26T12:05:00Z",
      },
    ]);
  });

  it("floors the fields an older server omits — 0/null, never NaN", async () => {
    stubFetch({
      "/api/ps": () => jsonResponse({ models: [{ name: "old:1b" }] }),
    });
    const [model] = await createClient().listRunning();
    expect(model).toEqual({
      tag: "old:1b",
      sizeBytes: 0,
      sizeVramBytes: 0,
      contextLength: null,
      expiresAt: null,
    });
    expect(Number.isNaN(model.sizeBytes)).toBe(false);
    expect(Number.isNaN(model.sizeVramBytes)).toBe(false);
  });

  it("reads size_vram: 0 as CPU-only rather than as missing", async () => {
    stubFetch({
      "/api/ps": () =>
        jsonResponse({ models: [{ name: "cpu:1b", size: 1_000, size_vram: 0 }] }),
    });
    const [model] = await createClient().listRunning();
    expect(model.sizeBytes).toBe(1_000);
    expect(model.sizeVramBytes).toBe(0);
  });

  it("treats the year-1 expires_at sentinel as no expiry at all", async () => {
    // Ollama writes Go's zero time for an infinite keep_alive.
    stubFetch({
      "/api/ps": () =>
        jsonResponse({
          models: [
            { name: "forever:1b", expires_at: "0001-01-01T00:00:00Z" },
            { name: "junk:1b", expires_at: "not a date" },
            { name: "blank:1b", expires_at: "" },
          ],
        }),
    });
    const running = await createClient().listRunning();
    expect(running.map((m) => m.expiresAt)).toEqual([null, null, null]);
  });

  it("empty /api/ps is an empty list, not a throw", async () => {
    stubFetch({ "/api/ps": () => jsonResponse({}) });
    await expect(createClient().listRunning()).resolves.toEqual([]);
  });
});

describe("listModelsWithRunning", () => {
  it("returns both readouts from the same two requests listModels makes", async () => {
    const stub = stubFetch({
      "/api/tags": () => jsonResponse(TAGS),
      "/api/ps": () =>
        jsonResponse({
          models: [
            {
              name: "llama3.1:8b",
              size: 6_000_000_000,
              size_vram: 6_000_000_000,
              context_length: 4096,
              expires_at: "2026-08-26T12:05:00Z",
            },
          ],
        }),
    });
    const { models, running } = await createClient().listModelsWithRunning();
    expect(models.find((m) => m.tag === "llama3.1:8b")?.isLoaded).toBe(true);
    expect(models.find((m) => m.tag === "gemma2:9b")?.isLoaded).toBe(false);
    expect(running).toEqual([
      {
        tag: "llama3.1:8b",
        sizeBytes: 6_000_000_000,
        sizeVramBytes: 6_000_000_000,
        contextLength: 4096,
        expiresAt: "2026-08-26T12:05:00Z",
      },
    ]);
    // The whole point: no third request for the runtime numbers.
    expect(stub.mock.calls).toHaveLength(2);
    expect(
      stub.mock.calls.filter((call) => String(call[0]).endsWith("/api/ps")),
    ).toHaveLength(1);
  });
});

/* ── listGroups() ───────────────────────────────────────────────────────── */

describe("listGroups", () => {
  function stubShowRoutes(modelfiles: Record<string, string>): FetchStub {
    const tags = {
      models: Object.keys(modelfiles).map((name) => ({
        name,
        size: 1,
        modified_at: "2026-08-01T00:00:00Z",
        details: { family: "llama", parameter_size: "8B", quantization_level: "Q4" },
      })),
    };
    return stubFetch({
      "/api/tags": () => jsonResponse(tags),
      "/api/ps": () => jsonResponse({ models: [] }),
      "/api/show": (init) => {
        const tag = String(bodyOf(init).model);
        return jsonResponse({ modelfile: modelfiles[tag] ?? "" });
      },
    });
  }

  it("groups a variant under its FROM base", async () => {
    stubShowRoutes({
      "llama3.1:8b": "FROM /blobs/sha256-abc\nTEMPLATE xyz",
      "tuned:latest": "FROM llama3.1:8b\nSYSTEM be terse",
    });
    const groups = await createClient().listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].base.tag).toBe("llama3.1:8b");
    expect(groups[0].variants.map((v) => v.tag)).toEqual(["tuned:latest"]);
    expect(groups[0].variants[0].base).toBe("llama3.1:8b");
    expect(groups[0].variants[0].isVariant).toBe(true);
  });

  it("normalizes :latest and case when matching FROM to a local tag", async () => {
    stubShowRoutes({
      "base2:latest": "FROM /blobs/sha256-def",
      "v2:1b": "FROM Base2\nSYSTEM hi",
    });
    const groups = await createClient().listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].base.tag).toBe("base2:latest");
    expect(groups[0].variants.map((v) => v.tag)).toEqual(["v2:1b"]);
  });

  it("puts a model whose FROM names no local model in its own group", async () => {
    stubShowRoutes({
      "orphan:1b": "FROM missing:9b\nSYSTEM hello",
    });
    const groups = await createClient().listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].base.tag).toBe("orphan:1b");
    expect(groups[0].base.isVariant).toBe(false);
    expect(groups[0].base.base).toBeNull();
    expect(groups[0].variants).toEqual([]);
  });

  /**
   * The real shape from a current server: FROM is a blob path and the
   * `# FROM` comment names the model itself, so only `details.parent_model`
   * says what this was built from.
   */
  function stubParentRoutes(parents: Record<string, string>): FetchStub {
    const tags = {
      models: Object.entries(parents).map(([name, parent_model]) => ({
        name,
        size: 1,
        modified_at: "2026-08-01T00:00:00Z",
        details: { family: "llama", parameter_size: "8B", quantization_level: "Q4", parent_model },
      })),
    };
    return stubFetch({
      "/api/tags": () => jsonResponse(tags),
      "/api/ps": () => jsonResponse({ models: [] }),
      "/api/show": (init) => {
        const tag = String(bodyOf(init).model);
        return jsonResponse({
          modelfile: `# Modelfile generated by "ollama show"\n# FROM ${tag}\n\nFROM /blobs/sha256-abc\n`,
        });
      },
    });
  }

  it("groups a variant under the parent reported in details.parent_model", async () => {
    stubParentRoutes({
      "qwen:latest": "",
      "qwen-q8:latest": "",
      "qwen-coding-q4:latest": "qwen:latest",
      "qwen-coding-q8:latest": "qwen-q8:latest",
    });
    const groups = await createClient().listGroups();
    expect(groups.map((g) => g.base.tag)).toEqual(["qwen:latest", "qwen-q8:latest"]);
    expect(groups[0].variants.map((v) => v.tag)).toEqual(["qwen-coding-q4:latest"]);
    expect(groups[1].variants.map((v) => v.tag)).toEqual(["qwen-coding-q8:latest"]);
    expect(groups[0].variants[0].isVariant).toBe(true);
  });

  it("keeps a tag whose reported parent isn't installed as its own base", async () => {
    stubParentRoutes({ "solo:1b": "deleted-parent:latest" });
    const groups = await createClient().listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].base.tag).toBe("solo:1b");
    expect(groups[0].base.isVariant).toBe(false);
  });

  it("calls /api/show once per model", async () => {
    const stub = stubShowRoutes({
      "llama3.1:8b": "FROM /blobs/sha256-abc",
      "tuned:latest": "FROM llama3.1:8b",
    });
    await createClient().listGroups();
    const showCalls = stub.mock.calls.filter((call) =>
      String(call[0]).endsWith("/api/show"),
    );
    expect(showCalls).toHaveLength(2);
  });

  it("fills capabilities from the cached show response, without extra requests", async () => {
    const shows: Record<string, unknown> = {
      "llama3.1:8b": {
        modelfile: "FROM /blobs/sha256-abc",
        capabilities: ["completion", "tools", "thinking"],
      },
      // No capabilities field at all — an older server.
      "gemma2:9b": { modelfile: "FROM /blobs/sha256-def" },
      // Malformed: not an array of strings. Defaults, doesn't throw.
      "weird:1b": { modelfile: "FROM /blobs/sha256-fff", capabilities: "tools" },
    };
    const tags = {
      models: Object.keys(shows).map((name) => ({
        name,
        size: 1,
        modified_at: "2026-08-01T00:00:00Z",
        details: { family: "llama", parameter_size: "8B", quantization_level: "Q4" },
      })),
    };
    const stub = stubFetch({
      "/api/tags": () => jsonResponse(tags),
      "/api/ps": () => jsonResponse({ models: [] }),
      "/api/show": (init) => jsonResponse(shows[String(bodyOf(init).model)]),
    });
    const groups = await createClient().listGroups();
    const byTag = new Map(groups.map((g) => [g.base.tag, g.base]));
    expect(byTag.get("llama3.1:8b")?.capabilities).toEqual([
      "completion",
      "tools",
      "thinking",
    ]);
    expect(byTag.get("gemma2:9b")?.capabilities).toEqual([]);
    expect(byTag.get("weird:1b")?.capabilities).toEqual([]);
    // One /api/show per model and no more — capabilities ride the same sweep.
    expect(
      stub.mock.calls.filter((call) => String(call[0]).endsWith("/api/show")),
    ).toHaveLength(3);
  });
});

/* ── show() ─────────────────────────────────────────────────────────────── */

describe("show", () => {
  it("maps the family-prefixed context_length key", async () => {
    stubFetch({
      "/api/show": () =>
        jsonResponse({
          modelfile: "FROM /blobs/sha256-abc",
          parameters: "temperature 0.7",
          template: "{{ .Prompt }}",
          system: "be terse",
          details: {
            family: "llama",
            parameter_size: "8.0B",
            quantization_level: "Q4_K_M",
          },
          model_info: {
            "general.architecture": "llama",
            "llama.context_length": 131072,
          },
        }),
    });
    const detail = await createClient().show("llama3.1:8b");
    expect(detail.contextLength).toBe(131072);
    expect(detail.details).toEqual({
      family: "llama",
      parameterSize: "8.0B",
      quantizationLevel: "Q4_K_M",
    });
    expect(detail.capabilities).toEqual([]);
  });

  it("carries capabilities through, and defaults to [] when absent", async () => {
    stubFetch({
      "/api/show": () =>
        jsonResponse({ modelfile: "FROM x", capabilities: ["completion", "vision"] }),
    });
    const detail = await createClient().show("llava:7b");
    expect(detail.capabilities).toEqual(["completion", "vision"]);
  });

  /* ── archParams ─────────────────────────────────────────────────────── */

  it("parses archParams from a full model_info fixture", async () => {
    stubFetch({
      "/api/show": () =>
        jsonResponse({
          modelfile: "FROM x",
          model_info: {
            "general.architecture": "llama",
            "llama.block_count": 32,
            "llama.attention.head_count": 32,
            "llama.attention.head_count_kv": 8,
            "llama.embedding_length": 4096,
          },
        }),
    });
    const detail = await createClient().show("llama3.1:8b");
    expect(detail.archParams).toEqual({
      architecture: "llama",
      blockCount: 32,
      headCount: 32,
      headCountKv: 8,
      embeddingLength: 4096,
    });
  });

  it("archParams is null when general.architecture is absent", async () => {
    stubFetch({
      "/api/show": () =>
        jsonResponse({
          modelfile: "FROM x",
          model_info: {
            "llama.block_count": 32,
            "llama.attention.head_count": 32,
            "llama.attention.head_count_kv": 8,
            "llama.embedding_length": 4096,
          },
        }),
    });
    const detail = await createClient().show("llama3.1:8b");
    expect(detail.archParams).toBeNull();
  });

  it("archParams is null when exactly one of the four numeric keys is missing", async () => {
    stubFetch({
      "/api/show": () =>
        jsonResponse({
          modelfile: "FROM x",
          model_info: {
            "general.architecture": "llama",
            "llama.block_count": 32,
            "llama.attention.head_count": 32,
            "llama.attention.head_count_kv": 8,
            // "llama.embedding_length" deliberately omitted.
          },
        }),
    });
    const detail = await createClient().show("llama3.1:8b");
    expect(detail.archParams).toBeNull();
  });
});

/* ── chat() ─────────────────────────────────────────────────────────────── */

describe("chat", () => {
  it("yields streamed chunks and final stats, split across chunk boundaries", async () => {
    const stub = stubFetch({
      "/api/chat": () =>
        streamResponse([
          '{"message":{"content":"Hel"},"done":false}\n{"message":{"content"',
          ':"lo"},"done":false}\n',
          '{"message":{"content":""},"done":true,"eval_count":42,"eval_duration":2000000000}\n',
        ]),
    });
    const chunks = await collect(
      createClient().chat("llama3.1:8b", [{ role: "user", content: "hi" }], {
        keepAlive: "5m",
      }),
    );
    expect(chunks).toEqual<ChatChunk[]>([
      { content: "Hel", done: false },
      { content: "lo", done: false },
      {
        content: "",
        done: true,
        stats: { evalCount: 42, evalDurationNs: 2000000000 },
      },
    ]);
    expect(bodyOf(stub.mock.calls[0][1])).toEqual({
      model: "llama3.1:8b",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      keep_alive: "5m",
    });
  });

  it("passes the signal to fetch and rejects mid-stream on abort", async () => {
    const encoder = new TextEncoder();
    // One chunk, then the stream stays open — as a live generation would.
    const hangingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('{"message":{"content":"Hel"},"done":false}\n'),
        );
      },
    });
    const stub = stubFetch({
      "/api/chat": () =>
        ({
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({}),
          body: hangingBody,
        }) as unknown as Response,
    });
    const controller = new AbortController();
    const iterator = createClient()
      .chat("llama3.1:8b", [{ role: "user", content: "hi" }], {
        keepAlive: "5m",
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ content: "Hel", done: false });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(stub.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  /** One done-line stub; returns the body the client sent. */
  async function chatBody(
    opts: Parameters<ReturnType<typeof createClient>["chat"]>[2],
    messages: ChatMessage[] = [{ role: "user", content: "hi" }],
  ): Promise<Record<string, unknown>> {
    const stub = stubFetch({
      "/api/chat": () => streamResponse(['{"message":{"content":"ok"},"done":true}\n']),
    });
    await collect(createClient().chat("m:1b", messages, opts));
    return bodyOf(stub.mock.calls[0][1]);
  }

  it("omits `think` when unset, but sends false for an explicit \"off\"", async () => {
    // Ollama declares `think` omitempty on a nil-distinguishable type, so
    // absent means "model's default" — which is reasoning ON for models it
    // treats as always-thinking. Omitting for an explicit "off" would leave
    // the control unable to do the one thing it is named for.
    expect(await chatBody({ keepAlive: "5m" })).not.toHaveProperty("think");
    expect(await chatBody({ keepAlive: "5m", think: "off" })).toMatchObject({ think: false });
  });

  it("sends a set think level verbatim", async () => {
    for (const level of ["low", "medium", "high"] as const) {
      expect(await chatBody({ keepAlive: "5m", think: level })).toMatchObject({
        think: level,
      });
    }
  });

  it("maps run options to snake_case and drops the keys that are unset", async () => {
    const body = await chatBody({
      keepAlive: "5m",
      options: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        seed: 42,
        numPredict: 256,
        repeatPenalty: 1.1,
        numCtx: 8192,
      },
    });
    expect(body.options).toEqual({
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      seed: 42,
      num_predict: 256,
      repeat_penalty: 1.1,
      num_ctx: 8192,
    });
  });

  it("omits explicitly-undefined option keys — absent is not the same as null", async () => {
    const body = await chatBody({
      keepAlive: "5m",
      options: { temperature: 0.2, topP: undefined, numCtx: undefined },
    });
    // Not toEqual: toEqual would let an `undefined`-valued key through.
    expect(Object.keys(body.options as object)).toEqual(["temperature"]);
    expect(JSON.stringify(body.options)).toBe('{"temperature":0.2}');
  });

  it("omits the whole options object when nothing is set", async () => {
    expect(await chatBody({ keepAlive: "5m", options: {} })).not.toHaveProperty("options");
    expect(await chatBody({ keepAlive: "5m" })).not.toHaveProperty("options");
  });

  it("passes images through and never sends thumbs or reasoning back", async () => {
    const body = await chatBody({ keepAlive: "5m" }, [
      {
        role: "assistant",
        content: "done",
        // Ollama does not take reasoning back as context.
        thinking: "let me think...",
      },
      {
        role: "user",
        content: "what is this",
        images: ["QkFTRTY0"],
        imageThumbs: ["data:image/png;base64,QkFTRTY0"],
      },
    ]);
    expect(body.messages).toEqual([
      { role: "assistant", content: "done" },
      { role: "user", content: "what is this", images: ["QkFTRTY0"] },
    ]);
    expect(JSON.stringify(body.messages)).not.toContain("thinking");
    expect(JSON.stringify(body.messages)).not.toContain("data:image");
  });

  it("keeps thinking deltas out of content and reports the full timing breakdown", async () => {
    stubFetch({
      "/api/chat": () =>
        streamResponse([
          '{"message":{"thinking":"first "},"done":false}\n',
          '{"message":{"thinking":"second","content":"Hi"},"done":false}\n',
          '{"message":{"content":" there"},"done":true,"eval_count":42,' +
            '"eval_duration":2000000000,"prompt_eval_count":11,' +
            '"prompt_eval_duration":500000000,"load_duration":1500000000,' +
            '"total_duration":4000000000}\n',
        ]),
    });
    const chunks = await collect(
      createClient().chat("m:1b", [{ role: "user", content: "hi" }], { keepAlive: "5m" }),
    );
    expect(chunks).toEqual<ChatChunk[]>([
      { content: "", thinking: "first ", done: false },
      { content: "Hi", thinking: "second", done: false },
      {
        content: " there",
        done: true,
        stats: {
          evalCount: 42,
          evalDurationNs: 2000000000,
          promptEvalCount: 11,
          promptEvalDurationNs: 500000000,
          loadDurationNs: 1500000000,
          totalDurationNs: 4000000000,
        },
      },
    ]);
  });

  it("leaves the newer timing fields absent when the server omits them", async () => {
    stubFetch({
      "/api/chat": () =>
        streamResponse([
          '{"message":{"content":"x"},"done":true,"eval_count":8,"eval_duration":1000000000}\n',
        ]),
    });
    const [chunk] = await collect(
      createClient().chat("m:1b", [{ role: "user", content: "hi" }], { keepAlive: "5m" }),
    );
    expect(chunk.stats).toEqual({ evalCount: 8, evalDurationNs: 1000000000 });
    expect(chunk.stats).not.toHaveProperty("promptEvalCount");
  });

  /* ── tools ──────────────────────────────────────────────────────────── */

  it("sends `tools` verbatim when supplied, and omits the key entirely when not", async () => {
    const tools = [{ type: "function", function: { name: "get_weather" } }];
    expect(await chatBody({ keepAlive: "5m", tools })).toMatchObject({ tools });
    expect(await chatBody({ keepAlive: "5m" })).not.toHaveProperty("tools");
    expect(await chatBody({ keepAlive: "5m", tools: [] })).not.toHaveProperty("tools");
  });

  /* ── format (docs/SPEC-round-two.md R2) ─────────────────────────────── */

  it("omits `format` entirely when unset — never \"\" and never null", async () => {
    // "off" is the *absence* of the field. An empty string is a format
    // Ollama would try to honour, which is a different instruction.
    const body = await chatBody({ keepAlive: "5m" });
    expect(body).not.toHaveProperty("format");
    expect(JSON.stringify(body)).not.toContain("format");
  });

  it("sends the literal string for `json` mode", async () => {
    expect(await chatBody({ keepAlive: "5m", format: "json" })).toMatchObject({
      format: "json",
    });
  });

  it("sends a JSON Schema as a parsed object, not a string", async () => {
    const schema = {
      type: "object",
      properties: { summary: { type: "string" }, breaking: { type: "boolean" } },
      required: ["summary"],
    };
    const body = await chatBody({ keepAlive: "5m", format: schema });
    expect(body.format).toEqual(schema);
    // Ollama takes the schema as an object; a re-serialised string here
    // would be accepted as a `format` name and constrain nothing.
    expect(typeof body.format).toBe("object");
  });

  it("yields tool_calls with arguments still an object, never JSON.parse'd", async () => {
    stubFetch({
      "/api/chat": () =>
        streamResponse([
          '{"message":{"content":"","tool_calls":[{"function":{"name":"get_weather",' +
            '"arguments":{"city":"Wellington"}}}]},"done":false}\n',
          '{"message":{"content":""},"done":true}\n',
        ]),
    });
    const [chunk] = await collect(
      createClient().chat("m:1b", [{ role: "user", content: "hi" }], { keepAlive: "5m" }),
    );
    expect(chunk.toolCalls).toEqual([
      { name: "get_weather", arguments: { city: "Wellington" } },
    ]);
  });

  it("drops malformed tool_calls entries defensively", async () => {
    stubFetch({
      "/api/chat": () =>
        streamResponse([
          '{"message":{"content":"","tool_calls":[' +
            '{"function":{"name":"a","arguments":"not-an-object"}},' +
            '{"function":{"arguments":{"x":1}}},' +
            '{"function":{"name":"b"}}' +
            ']},"done":false}\n',
          '{"message":{"content":""},"done":true}\n',
        ]),
    });
    const [chunk] = await collect(
      createClient().chat("m:1b", [{ role: "user", content: "hi" }], { keepAlive: "5m" }),
    );
    // "a" survives with arguments defaulted to {}; the entry missing
    // function.name is dropped; "b" survives with arguments defaulted to {}.
    expect(chunk.toolCalls).toEqual([
      { name: "a", arguments: {} },
      { name: "b", arguments: {} },
    ]);
  });

  it("yields no toolCalls field at all when tool_calls isn't an array", async () => {
    stubFetch({
      "/api/chat": () =>
        streamResponse([
          '{"message":{"content":"hi","tool_calls":"nope"},"done":true}\n',
        ]),
    });
    const [chunk] = await collect(
      createClient().chat("m:1b", [{ role: "user", content: "hi" }], { keepAlive: "5m" }),
    );
    expect(chunk).not.toHaveProperty("toolCalls");
  });
});

/* ── errors ─────────────────────────────────────────────────────────────── */

describe("error handling", () => {
  it("includes status and the server's error text verbatim on non-2xx", async () => {
    stubFetch({
      "/api/show": () =>
        jsonResponse({ error: 'model "nope:1b" not found' }, 404),
    });
    await expect(createClient().show("nope:1b")).rejects.toThrow(
      /404.*model "nope:1b" not found/,
    );
  });

  it("create() sends the structured body, and falls back to legacy modelfile on 400", async () => {
    // First server: accepts structured — assert the body carries `from`,
    // not `modelfile`.
    let structuredBody: Record<string, unknown> | null = null;
    stubFetch({
      "/api/create": (init) => {
        structuredBody = bodyOf(init);
        return streamResponse(['{"status":"success"}\n']);
      },
    });
    const req = {
      from: "llama3.1:8b",
      system: "Be brief.",
      parameters: { temperature: 0.7, stop: ["</s>"] },
      rawModelfile: "FROM llama3.1:8b\nSYSTEM Be brief.",
    };
    const statuses = await collect(createClient().create("support-bot", req));
    expect(statuses).toEqual([{ status: "success" }]);
    expect(structuredBody).toMatchObject({
      model: "support-bot",
      from: "llama3.1:8b",
      system: "Be brief.",
      parameters: { temperature: 0.7, stop: ["</s>"] },
    });
    expect(structuredBody).not.toHaveProperty("modelfile");

    // Second server: rejects structured with 400 → the client retries once
    // with the legacy body.
    const bodies: Record<string, unknown>[] = [];
    stubFetch({
      "/api/create": (init) => {
        const body = bodyOf(init);
        bodies.push(body);
        if ("modelfile" in body) {
          return streamResponse(['{"status":"success"}\n']);
        }
        return jsonResponse({ error: "unknown field from" }, 400);
      },
    });
    const legacy = await collect(createClient().create("support-bot", req));
    expect(legacy).toEqual([{ status: "success" }]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ model: "support-bot", modelfile: req.rawModelfile });
  });

  it("create() rethrows the ORIGINAL structured error when the legacy retry also fails", async () => {
    // A current server rejecting content 400s on BOTH bodies; the structured
    // error is the accurate one and must be what surfaces.
    stubFetch({
      "/api/create": (init) =>
        "modelfile" in bodyOf(init)
          ? jsonResponse({ error: "modelfile is unsupported" }, 400)
          : jsonResponse({ error: "invalid parameter: num_ctx" }, 400),
    });
    const iterate = async () => {
      await collect(
        createClient().create("bad:1b", { from: "x", rawModelfile: "FROM x" }),
      );
    };
    await expect(iterate()).rejects.toThrow(/invalid parameter: num_ctx/);
  });

  it("create() sends quantize in the structured body", async () => {
    let body: Record<string, unknown> | null = null;
    stubFetch({
      "/api/create": (init) => {
        body = bodyOf(init);
        return streamResponse(['{"status":"success"}\n']);
      },
    });
    await collect(
      createClient().create("small:latest", {
        from: "llama3.1:8b",
        quantize: "q4_K_M",
        rawModelfile: "FROM llama3.1:8b",
      }),
    );
    expect(body).toMatchObject({ model: "small:latest", quantize: "q4_K_M" });
  });

  it("create() omits quantize when unset", async () => {
    let body: Record<string, unknown> | null = null;
    stubFetch({
      "/api/create": (init) => {
        body = bodyOf(init);
        return streamResponse(['{"status":"success"}\n']);
      },
    });
    await collect(
      createClient().create("plain:latest", { from: "x", rawModelfile: "FROM x" }),
    );
    expect(body).not.toHaveProperty("quantize");
  });

  it("create() refuses the legacy fallback when quantize is set, rather than dropping it", async () => {
    // The legacy `modelfile` string can't express quantisation. Falling back
    // would succeed while producing an UNquantised model under the name the
    // user asked to quantise — so the original error must propagate instead.
    const bodies: Record<string, unknown>[] = [];
    stubFetch({
      "/api/create": (init) => {
        const body = bodyOf(init);
        bodies.push(body);
        // A server old enough to reject `from` would happily take `modelfile`.
        if ("modelfile" in body) {
          return streamResponse(['{"status":"success"}\n']);
        }
        return jsonResponse({ error: "unknown field from" }, 400);
      },
    });
    const iterate = async () => {
      await collect(
        createClient().create("small:latest", {
          from: "llama3.1:8b",
          quantize: "q4_K_M",
          rawModelfile: "FROM llama3.1:8b",
        }),
      );
    };
    await expect(iterate()).rejects.toThrow(/unknown field from/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("modelfile");
  });

  it("create() surfaces a 400 with the server's error text", async () => {
    stubFetch({
      "/api/create": () =>
        jsonResponse({ error: "error parsing modelfile" }, 400),
    });
    const iterate = async () => {
      await collect(
        createClient().create("bad:1b", { from: "nothing", rawModelfile: "FRUM nothing" }),
      );
    };
    await expect(iterate()).rejects.toThrow(/400.*error parsing modelfile/);
  });
});

/* ── truncated streams ─────────────────────────────────────────────────── */

describe("truncated stream detection", () => {
  it("chat() throws when the stream ends without done: true", async () => {
    stubFetch({
      "/api/chat": () =>
        streamResponse([
          '{"message":{"content":"Hel"},"done":false}\n',
          '{"message":{"content":"lo"},"done":false}\n',
          // stream ends — no done: true line
        ]),
    });
    const iterate = async () => {
      await collect(
        createClient().chat("llama3.1:8b", [{ role: "user", content: "hi" }], {
          keepAlive: "5m",
        }),
      );
    };
    await expect(iterate()).rejects.toThrow(/chat stream ended without a done message/);
  });

  it("create() throws when the stream ends without status: 'success'", async () => {
    stubFetch({
      "/api/create": () =>
        streamResponse([
          '{"status":"reading model metadata"}\n',
          '{"status":"creating system layer"}\n',
          // stream ends — no status: "success" line
        ]),
    });
    const iterate = async () => {
      await collect(
        createClient().create("bot:latest", {
          from: "llama3.1:8b",
          rawModelfile: "FROM llama3.1:8b",
        }),
      );
    };
    await expect(iterate()).rejects.toThrow(/create stream ended without a success status/);
  });

  it("pull() throws when the stream ends without status: 'success'", async () => {
    stubFetch({
      "/api/pull": () =>
        streamResponse([
          '{"status":"pulling manifest"}\n',
          '{"status":"pulling sha256:abc","digest":"sha256:abc","total":1000,"completed":500}\n',
          // stream ends — no status: "success" line
        ]),
    });
    const iterate = async () => {
      await collect(createClient().pull("llama3.1:8b"));
    };
    await expect(iterate()).rejects.toThrow(/pull stream ended without a success status/);
  });
});

/* ── load: num_ctx ─────────────────────────────────────────────────────── */

describe("load", () => {
  it("omits options entirely when no num_ctx is chosen", async () => {
    const stub = stubFetch({
      "/api/generate": () => jsonResponse({ done: true }),
    });
    await createClient().load("llama3.1:8b", "5m");

    const body = bodyOf(stub.mock.calls[0][1]);
    expect(body).toEqual({
      model: "llama3.1:8b",
      prompt: "",
      keep_alive: "5m",
      stream: false,
    });
    // Absent, not null: an explicit options block would override the
    // Modelfile's own PARAMETER num_ctx (SPEC-tuning T4).
    expect(body).not.toHaveProperty("options");
  });

  it("sends num_ctx as a load-time option when one is chosen", async () => {
    const stub = stubFetch({
      "/api/generate": () => jsonResponse({ done: true }),
    });
    await createClient().load("llama3.1:8b", "5m", undefined, 16384);

    expect(bodyOf(stub.mock.calls[0][1])).toEqual({
      model: "llama3.1:8b",
      prompt: "",
      keep_alive: "5m",
      stream: false,
      options: { num_ctx: 16384 },
    });
  });

  it("ignores a non-positive num_ctx rather than sending a nonsense window", async () => {
    const stub = stubFetch({
      "/api/generate": () => jsonResponse({ done: true }),
    });
    await createClient().load("llama3.1:8b", "5m", undefined, 0);

    expect(bodyOf(stub.mock.calls[0][1])).not.toHaveProperty("options");
  });

  it("omits num_gpu entirely when unset (R1: absent, never 0)", async () => {
    const stub = stubFetch({
      "/api/generate": () => jsonResponse({ done: true }),
    });
    await createClient().load("llama3.1:8b", "5m", undefined, undefined, undefined);

    const body = bodyOf(stub.mock.calls[0][1]);
    expect(body).not.toHaveProperty("options");
  });

  it("sends num_gpu: 0 as a real instruction, not as unset", async () => {
    const stub = stubFetch({
      "/api/generate": () => jsonResponse({ done: true }),
    });
    await createClient().load("llama3.1:8b", "5m", undefined, undefined, 0);

    expect(bodyOf(stub.mock.calls[0][1])).toEqual({
      model: "llama3.1:8b",
      prompt: "",
      keep_alive: "5m",
      stream: false,
      options: { num_gpu: 0 },
    });
  });

  it("sends num_gpu as a load-time option when one is chosen", async () => {
    const stub = stubFetch({
      "/api/generate": () => jsonResponse({ done: true }),
    });
    await createClient().load("llama3.1:8b", "5m", undefined, undefined, 24);

    expect(bodyOf(stub.mock.calls[0][1])).toEqual({
      model: "llama3.1:8b",
      prompt: "",
      keep_alive: "5m",
      stream: false,
      options: { num_gpu: 24 },
    });
  });

  it("carries num_ctx and num_gpu together in the same options object", async () => {
    const stub = stubFetch({
      "/api/generate": () => jsonResponse({ done: true }),
    });
    await createClient().load("llama3.1:8b", "5m", undefined, 16384, 24);

    expect(bodyOf(stub.mock.calls[0][1]).options).toEqual({ num_ctx: 16384, num_gpu: 24 });
  });
});

/* ── chat: tool results going back out ─────────────────────────────────── */

describe("chat outbound tool messages", () => {
  it("re-encodes assistant toolCalls to Ollama's shape and sends tool_name", async () => {
    const stub = stubFetch({
      "/api/chat": () => streamResponse(['{"done":true,"eval_count":1,"eval_duration":1}\n']),
    });
    await collect(
      createClient().chat(
        "qwen2.5:7b",
        [
          { role: "user", content: "weather in Wellington?" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ name: "get_weather", arguments: { city: "Wellington" } }],
          },
          { role: "tool", content: '{"temp_c":13}', toolName: "get_weather" },
        ],
        { keepAlive: "5m" },
      ),
    );

    const body = bodyOf(stub.mock.calls[0][1]) as { messages: unknown[] };
    // Domain shape is { name, arguments }; the wire nests it under `function`.
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "get_weather", arguments: { city: "Wellington" } } }],
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      content: '{"temp_c":13}',
      tool_name: "get_weather",
    });
  });

  it("omits tool_calls and tool_name when absent — an ordinary turn is unchanged", async () => {
    const stub = stubFetch({
      "/api/chat": () => streamResponse(['{"done":true,"eval_count":1,"eval_duration":1}\n']),
    });
    await collect(
      createClient().chat("qwen2.5:7b", [{ role: "user", content: "hi" }], { keepAlive: "5m" }),
    );

    const body = bodyOf(stub.mock.calls[0][1]) as { messages: unknown[] };
    expect(body.messages[0]).toEqual({ role: "user", content: "hi" });
  });
});
