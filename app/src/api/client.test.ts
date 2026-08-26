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

  it("omits `think` entirely for undefined and for \"off\"", async () => {
    expect(await chatBody({ keepAlive: "5m" })).not.toHaveProperty("think");
    expect(await chatBody({ keepAlive: "5m", think: "off" })).not.toHaveProperty("think");
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
