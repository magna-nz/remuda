import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./client";
import { DEFAULT_BASE_URL } from "./types";
import type { ChatChunk } from "./types";

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
      },
    ]);
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
