/**
 * The benchmark run loop (docs/SPEC-round-two.md R7).
 *
 * Every rule in run.ts has a test here: one seed across every lane and
 * every prompt, a load per lane rather than per prompt, an errored cell
 * that is a result rather than an abort, a lane whose model will not load,
 * a cancel that keeps its finished cells and is marked partial, and one
 * message per request.
 */
import { describe, expect, it } from "vitest";
import type { ChatChunk, ChatMessage } from "../api/types";
import { addLane, addPrompt, createBenchmark } from "./benchmarks";
import { runBenchmark, type BenchmarkChat, type BenchmarkLoad } from "./run";
import type { Benchmark } from "./types";

function answer(text: string, evalCount = 10): ChatChunk[] {
  return [
    { content: text, done: false },
    { content: "", done: true, stats: { evalCount, evalDurationNs: 1_000_000_000 } },
  ];
}

interface ChatCall {
  model: string;
  messages: ChatMessage[];
  seed: number;
}

/**
 * A scripted server. `reply` decides what a model says to a prompt (or
 * throws, by returning an Error); `loadFails` names the models whose load
 * fails, with the reason. `log` records loads and chats in the order they
 * happened — which is what the lane-grouping rule is actually about.
 */
function server(options: {
  reply?: (model: string, prompt: string) => ChatChunk[] | Error;
  loadFails?: Record<string, string>;
  onChat?: (index: number) => void;
}) {
  const log: string[] = [];
  const calls: ChatCall[] = [];
  const load: BenchmarkLoad = async (model) => {
    log.push(`load ${model}`);
    const failure = options.loadFails?.[model];
    if (failure !== undefined) throw new Error(failure);
    await Promise.resolve();
  };
  const chat: BenchmarkChat = (model, messages, opts) => {
    const index = calls.length;
    const prompt = messages[0]!.content;
    log.push(`chat ${model} :: ${prompt}`);
    calls.push({ model, messages, seed: opts.seed });
    return (async function* () {
      options.onChat?.(index);
      const scripted = options.reply?.(model, prompt) ?? answer(`${model} says ${prompt}`);
      if (scripted instanceof Error) throw scripted;
      for (const chunk of scripted) {
        await Promise.resolve();
        yield chunk;
      }
    })();
  };
  return { load, chat, log, calls };
}

/** Two lanes, three prompts: six cells, two loads. */
function twoLanes(): Benchmark {
  let b = createBenchmark("Coding voice", "gemma-4-31b:latest");
  b = addLane(b, "qwen3.8-27b:latest", "terse-v2");
  b = addPrompt(b, "one");
  b = addPrompt(b, "two");
  b = addPrompt(b, "three");
  return b;
}

const never = (): AbortSignal => new AbortController().signal;

/** What fetch throws on an aborted request: an Error whose name is AbortError. */
function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

describe("runBenchmark", () => {
  it("pins one seed across every lane and every prompt", async () => {
    const b = twoLanes();
    const { load, chat, calls } = server({});
    const run = await runBenchmark({ benchmark: b, seed: 40412, signal: never(), chat, load });
    expect(calls).toHaveLength(6);
    // Two lanes on two seeds would measure sampling noise, which is the one
    // thing a benchmark must not do.
    expect(calls.map((c) => c.seed)).toEqual([40412, 40412, 40412, 40412, 40412, 40412]);
    expect(new Set(calls.map((c) => c.seed)).size).toBe(1);
    expect(run.seed).toBe(40412);
    expect(run.partial).toBe(false);
  });

  it("groups by lane: one load per lane, then all of that lane's prompts", async () => {
    const b = twoLanes();
    const { load, chat, log } = server({});
    await runBenchmark({ benchmark: b, seed: 1, signal: never(), chat, load });
    // Interleaving would be a full model load per prompt — on a 20 GB model
    // the difference between two loads and six.
    expect(log).toEqual([
      "load gemma-4-31b:latest",
      "chat gemma-4-31b:latest :: one",
      "chat gemma-4-31b:latest :: two",
      "chat gemma-4-31b:latest :: three",
      "load qwen3.8-27b:latest",
      "chat qwen3.8-27b:latest :: one",
      "chat qwen3.8-27b:latest :: two",
      "chat qwen3.8-27b:latest :: three",
    ]);
    expect(log.filter((l) => l.startsWith("load"))).toHaveLength(2);
  });

  it("tags every cell with its prompt and its lane", async () => {
    const b = twoLanes();
    const { load, chat } = server({});
    const run = await runBenchmark({ benchmark: b, seed: 1, signal: never(), chat, load });
    expect(run.cells.map((c) => [c.promptId, c.laneId])).toEqual([
      [b.prompts[0]!.id, b.lanes[0]!.id],
      [b.prompts[1]!.id, b.lanes[0]!.id],
      [b.prompts[2]!.id, b.lanes[0]!.id],
      [b.prompts[0]!.id, b.lanes[1]!.id],
      [b.prompts[1]!.id, b.lanes[1]!.id],
      [b.prompts[2]!.id, b.lanes[1]!.id],
    ]);
    expect(run.cells[3]!.content).toBe("qwen3.8-27b:latest says one");
  });

  it("sends one prompt per request, with no accumulated transcript", async () => {
    const { load, chat, calls } = server({});
    await runBenchmark({ benchmark: twoLanes(), seed: 1, signal: never(), chat, load });
    for (const call of calls) {
      expect(call.messages).toHaveLength(1);
      expect(call.messages[0]!.role).toBe("user");
    }
    expect(calls.map((c) => c.messages[0]!.content)).toEqual([
      "one",
      "two",
      "three",
      "one",
      "two",
      "three",
    ]);
  });

  it("keeps a failed cell as a result and carries on", async () => {
    const b = twoLanes();
    const { load, chat, calls } = server({
      reply: (model, prompt) =>
        model === "gemma-4-31b:latest" && prompt === "two"
          ? new Error("context length exceeded — prompt is 34102 tokens, num_ctx is 26624")
          : answer(`${model} says ${prompt}`),
    });
    const run = await runBenchmark({ benchmark: b, seed: 7, signal: never(), chat, load });
    // The failure did not abort the sweep: the rest of the lane, and the
    // whole of lane 2, still ran.
    expect(calls).toHaveLength(6);
    expect(run.cells).toHaveLength(6);
    expect(run.partial).toBe(false);
    expect(run.cells[1]!.error).toBe(
      "context length exceeded — prompt is 34102 tokens, num_ctx is 26624",
    );
    expect(run.cells[1]!.stats).toBeUndefined();
    expect(run.cells[2]!.content).toBe("gemma-4-31b:latest says three");
  });

  it("a lane whose model will not load fails that lane's cells and moves on", async () => {
    const b = twoLanes();
    const { load, chat, log, calls } = server({
      loadFails: { "gemma-4-31b:latest": 'model "gemma-4-31b:latest" not found' },
    });
    const run = await runBenchmark({ benchmark: b, seed: 3, signal: never(), chat, load });
    // Not one chat against the lane that could not load...
    expect(log).toEqual([
      "load gemma-4-31b:latest",
      "load qwen3.8-27b:latest",
      "chat qwen3.8-27b:latest :: one",
      "chat qwen3.8-27b:latest :: two",
      "chat qwen3.8-27b:latest :: three",
    ]);
    expect(calls).toHaveLength(3);
    // ...but three cells for it all the same, each with the load's own
    // reason. Blank cells would read as "not run".
    const failed = run.cells.filter((c) => c.laneId === b.lanes[0]!.id);
    expect(failed).toHaveLength(3);
    expect(failed.map((c) => c.error)).toEqual([
      'model "gemma-4-31b:latest" not found',
      'model "gemma-4-31b:latest" not found',
      'model "gemma-4-31b:latest" not found',
    ]);
    expect(failed.map((c) => c.promptId)).toEqual(b.prompts.map((p) => p.id));
    // One unavailable model does not cost you the lanes that do work.
    expect(run.cells).toHaveLength(6);
    expect(run.partial).toBe(false);
  });

  it("cancelling keeps the finished cells and marks the run partial", async () => {
    const b = twoLanes();
    const controller = new AbortController();
    const { load, chat, log } = server({
      // The cancel lands while lane 2's second prompt is in flight.
      reply: (model, prompt) => {
        if (model === "qwen3.8-27b:latest" && prompt === "two") {
          controller.abort();
          return abortError();
        }
        return answer(`${model} says ${prompt}`);
      },
    });
    const run = await runBenchmark({
      benchmark: b,
      seed: 99,
      signal: controller.signal,
      chat,
      load,
    });
    // Lane 2's third prompt was never attempted, and no third load happened.
    expect(log[log.length - 1]).toBe("chat qwen3.8-27b:latest :: two");
    // Four finished cells survive; the half-streamed one does not become a
    // cell, because half an answer reads as "different" for a reason that
    // has nothing to do with the model.
    expect(run.cells).toHaveLength(4);
    expect(run.cells.map((c) => c.content)).toEqual([
      "gemma-4-31b:latest says one",
      "gemma-4-31b:latest says two",
      "gemma-4-31b:latest says three",
      "qwen3.8-27b:latest says one",
    ]);
    expect(run.partial).toBe(true);
  });

  it("cancelling between lanes stops before the next load", async () => {
    const b = twoLanes();
    const controller = new AbortController();
    const { load, chat, log } = server({
      reply: (model, prompt) => {
        if (model === "gemma-4-31b:latest" && prompt === "three") controller.abort();
        return answer(`${model} says ${prompt}`);
      },
    });
    const run = await runBenchmark({
      benchmark: b,
      seed: 1,
      signal: controller.signal,
      chat,
      load,
    });
    // A cancel that lands as the last chunk arrives still drops that cell:
    // the answer may be truncated.
    expect(log.filter((l) => l.startsWith("load"))).toEqual(["load gemma-4-31b:latest"]);
    expect(run.cells).toHaveLength(2);
    expect(run.partial).toBe(true);
  });

  it("a signal already aborted produces an empty partial run, not a throw", async () => {
    const controller = new AbortController();
    controller.abort();
    const { load, chat, log } = server({});
    const run = await runBenchmark({
      benchmark: twoLanes(),
      seed: 3,
      signal: controller.signal,
      chat,
      load,
    });
    expect(log).toEqual([]);
    expect(run.cells).toEqual([]);
    expect(run.partial).toBe(true);
  });

  it("a benchmark with no prompts loads nothing at all", async () => {
    const { load, chat, log } = server({});
    const run = await runBenchmark({
      benchmark: createBenchmark("empty", "gemma-4-31b:latest"),
      seed: 1,
      signal: never(),
      chat,
      load,
    });
    expect(log).toEqual([]);
    expect(run.cells).toEqual([]);
  });

  it("reports the load as its own visible phase, lane by lane", async () => {
    const b = twoLanes();
    const { load, chat } = server({});
    const seen: string[] = [];
    await runBenchmark({
      benchmark: b,
      seed: 1,
      signal: never(),
      chat,
      load,
      onProgress: (p) => {
        seen.push(
          `${p.phase} ${p.lane.model} (lane ${p.laneNumber} of ${p.laneCount}) ${p.done}/${p.total}`,
        );
        expect(p.prompt === null).toBe(p.phase === "loading");
      },
    });
    // R7: "Loading qwen3.8-27b (lane 2 of 2)" rather than a UI that looks
    // hung for a minute.
    expect(seen[0]).toBe("loading gemma-4-31b:latest (lane 1 of 2) 0/6");
    expect(seen[4]).toBe("loading qwen3.8-27b:latest (lane 2 of 2) 3/6");
    expect(seen.filter((s) => s.startsWith("loading"))).toHaveLength(2);
  });

  it("reports each cell as it settles, failures included", async () => {
    const done: number[] = [];
    const { load, chat } = server({
      reply: (model, prompt) =>
        prompt === "two" ? new Error("boom") : answer(`${model} says ${prompt}`),
    });
    await runBenchmark({
      benchmark: twoLanes(),
      seed: 1,
      signal: never(),
      chat,
      load,
      onCell: (_cell, count, total) => {
        done.push(count);
        expect(total).toBe(6);
      },
    });
    // A failure counts as settled — it is a result, not a gap.
    expect(done).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("derives tok/s and wall time, and reports neither when the server sent no timings", async () => {
    let clock = 1000;
    let b = createBenchmark("b", "m:latest");
    b = addPrompt(b, "one");
    b = addPrompt(b, "two");
    const { load, chat } = server({
      reply: (_model, prompt) =>
        prompt === "one"
          ? [{ content: "hi", done: true, stats: { evalCount: 84, evalDurationNs: 2_000_000_000 } }]
          : [{ content: "hi", done: true }],
    });
    const run = await runBenchmark({
      benchmark: b,
      seed: 1,
      signal: never(),
      chat,
      load,
      now: () => (clock += 1200),
    });
    expect(run.cells[0]!.stats).toEqual({ evalCount: 84, tokPerSec: 42, ms: 1200 });
    // No timings from the server is "we don't know", never a fabricated rate
    // — and the count it never sent is null for the same reason. `ms` stays
    // a figure, because the runner measured that one itself.
    expect(run.cells[1]!.stats).toEqual({ evalCount: null, tokPerSec: null, ms: 1200 });
  });

  it("keeps thinking apart from content", async () => {
    let b = createBenchmark("b", "m:latest");
    b = addPrompt(b, "one");
    const { load, chat } = server({
      reply: () => [
        { content: "", thinking: "let me see", done: false },
        { content: "answer", done: true },
      ],
    });
    const run = await runBenchmark({ benchmark: b, seed: 1, signal: never(), chat, load });
    expect(run.cells[0]!.content).toBe("answer");
    expect(run.cells[0]!.thinking).toBe("let me see");
  });

  it("stamps the run from the injected clock", async () => {
    const { load, chat } = server({});
    const run = await runBenchmark({
      benchmark: twoLanes(),
      seed: 1,
      signal: never(),
      chat,
      load,
      clock: () => new Date("2026-08-29T12:00:00.000Z"),
    });
    expect(run.ranAt).toBe("2026-08-29T12:00:00.000Z");
    expect(run.id).not.toBe("");
  });
});

describe("stats the server did not report", () => {
  it("records no eval count rather than a count of zero", async () => {
    // A final chunk with no `stats` block: an older server, or a stream that
    // ended without one. "0 tok" under a full answer is a measurement the
    // reader will act on, and nothing was ever measured (SPEC §8).
    let b = createBenchmark("Voice", "gemma-4-31b:latest");
    b = addPrompt(b, "one");
    const { load, chat } = server({ reply: () => [{ content: "an answer", done: true }] });
    const run = await runBenchmark({ benchmark: b, seed: 5, signal: never(), chat, load });

    const stats = run.cells[0]?.stats;
    expect(stats).toBeDefined();
    expect(stats?.evalCount).toBeNull();
    expect(stats?.tokPerSec).toBeNull();
    // The duration is ours, measured here rather than reported, so it stays.
    expect(typeof stats?.ms).toBe("number");
  });

  it("keeps a real zero when the server actually reported one", async () => {
    let b = createBenchmark("Voice", "gemma-4-31b:latest");
    b = addPrompt(b, "one");
    const { load, chat } = server({ reply: () => answer("", 0) });
    const run = await runBenchmark({ benchmark: b, seed: 5, signal: never(), chat, load });
    expect(run.cells[0]?.stats?.evalCount).toBe(0);
  });
});
