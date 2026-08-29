/**
 * The replay loop (docs/SPEC-tuning.md T5, docs/SPEC-round-two.md R4).
 *
 * The four rules, each with a test: one pinned seed, an errored row that is
 * a result rather than an abort, a cancel that keeps its finished rows and
 * is marked partial, and one prompt per request with no accumulated
 * transcript.
 */
import { describe, expect, it } from "vitest";
import type { ChatChunk, ChatMessage } from "../api/types";
import { addPrompt, createBench, type Bench } from "./benches";
import { runBench, type BenchChat } from "./run";
import { buildRows, tally } from "./rows";

function answer(text: string, evalCount = 10): ChatChunk[] {
  return [
    { content: text, done: false },
    { content: "", done: true, stats: { evalCount, evalDurationNs: 1_000_000_000 } },
  ];
}

/** A scripted server: one entry per prompt, in order. An Error is thrown. */
function scripted(script: (ChatChunk[] | Error)[]) {
  const calls: { messages: ChatMessage[]; seed: number }[] = [];
  const chat: BenchChat = (messages, opts) => {
    const index = calls.length;
    calls.push({ messages, seed: opts.seed });
    const entry = script[index];
    return (async function* () {
      if (entry === undefined) return;
      if (entry instanceof Error) throw entry;
      for (const chunk of entry) {
        await Promise.resolve();
        yield chunk;
      }
    })();
  };
  return { chat, calls };
}

function threePrompts(): Bench {
  let bench = createBench("Coding voice", "terse-v2:latest");
  bench = addPrompt(bench, "Rewrite this loop to bail early.");
  bench = addPrompt(bench, "Explain a mutex to a Python programmer.");
  bench = addPrompt(bench, "Summarise this stack trace.");
  return bench;
}

describe("runBench", () => {
  it("pins one seed across every prompt of the run", async () => {
    const bench = threePrompts();
    const { chat, calls } = scripted([answer("a"), answer("b"), answer("c")]);
    const run = await runBench({
      bench,
      seed: 40412,
      snapshotId: "mf-abc",
      signal: new AbortController().signal,
      chat,
    });
    expect(calls).toHaveLength(3);
    // Two prompts on two seeds would measure sampling noise and nothing
    // else — the same reason T2 pins one for a compare pair.
    expect(calls.map((c) => c.seed)).toEqual([40412, 40412, 40412]);
    expect(run.seed).toBe(40412);
    expect(run.snapshotId).toBe("mf-abc");
    expect(run.partial).toBe(false);
  });

  it("sends one prompt per request, with no accumulated transcript", async () => {
    const { chat, calls } = scripted([answer("a"), answer("b"), answer("c")]);
    await runBench({
      bench: threePrompts(),
      seed: 1,
      snapshotId: null,
      signal: new AbortController().signal,
      chat,
    });
    for (const call of calls) {
      expect(call.messages).toHaveLength(1);
      expect(call.messages[0]!.role).toBe("user");
    }
    expect(calls.map((c) => c.messages[0]!.content)).toEqual([
      "Rewrite this loop to bail early.",
      "Explain a mutex to a Python programmer.",
      "Summarise this stack trace.",
    ]);
  });

  it("keeps a failed prompt as a result and carries on to the rest", async () => {
    const bench = threePrompts();
    const { chat, calls } = scripted([
      answer("first"),
      new Error("context length exceeded — prompt is 34102 tokens, num_ctx is 26624"),
      answer("third"),
    ]);
    const run = await runBench({
      bench,
      seed: 7,
      snapshotId: null,
      signal: new AbortController().signal,
      chat,
    });
    // The failure did NOT abort the sweep: prompt 3 still ran.
    expect(calls).toHaveLength(3);
    expect(run.results).toHaveLength(3);
    expect(run.partial).toBe(false);
    expect(run.results[1]!.error).toBe(
      "context length exceeded — prompt is 34102 tokens, num_ctx is 26624",
    );
    expect(run.results[1]!.stats).toBeUndefined();
    expect(run.results[2]!.content).toBe("third");
  });

  it("cancelling keeps the finished rows and marks the run partial", async () => {
    const bench = threePrompts();
    const controller = new AbortController();
    const calls: number[] = [];
    const chat: BenchChat = (_messages, opts) => {
      const index = calls.length;
      calls.push(index);
      return (async function* () {
        // Cancel lands while prompt 2 is in flight.
        if (index === 1) {
          controller.abort();
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        for (const chunk of answer(`answer ${index}`)) {
          await Promise.resolve();
          yield chunk;
        }
        expect(opts.seed).toBe(99);
      })();
    };
    const run = await runBench({
      bench,
      seed: 99,
      snapshotId: null,
      signal: controller.signal,
      chat,
    });
    // Prompt 3 was never attempted.
    expect(calls).toEqual([0, 1]);
    // The one finished row survives; the half-streamed one does not become
    // a row, because half an answer diffs as "changed" for a reason that
    // has nothing to do with the model.
    expect(run.results.map((r) => r.promptId)).toEqual([bench.prompts[0]!.id]);
    expect(run.results[0]!.content).toBe("answer 0");
    expect(run.partial).toBe(true);
  });

  it("a signal already aborted produces an empty partial run, not a throw", async () => {
    const controller = new AbortController();
    controller.abort();
    const { chat, calls } = scripted([answer("never")]);
    const run = await runBench({
      bench: threePrompts(),
      seed: 3,
      snapshotId: null,
      signal: controller.signal,
      chat,
    });
    expect(calls).toEqual([]);
    expect(run.results).toEqual([]);
    expect(run.partial).toBe(true);
  });

  it("reports progress as each prompt settles", async () => {
    const seen: number[] = [];
    const { chat } = scripted([answer("a"), new Error("boom"), answer("c")]);
    await runBench({
      bench: threePrompts(),
      seed: 1,
      snapshotId: null,
      signal: new AbortController().signal,
      chat,
      onResult: (_result, done, total) => {
        seen.push(done);
        expect(total).toBe(3);
      },
    });
    // The failure counts as settled — it is a result, not a gap.
    expect(seen).toEqual([1, 2, 3]);
  });

  it("derives tok/s and wall time, and reports neither when the server sent no timings", async () => {
    let clock = 1000;
    const bench = addPrompt(addPrompt(createBench("b", "m"), "one"), "two");
    const { chat } = scripted([
      [{ content: "hi", done: true, stats: { evalCount: 84, evalDurationNs: 2_000_000_000 } }],
      [{ content: "hi", done: true }],
    ]);
    const run = await runBench({
      bench,
      seed: 1,
      snapshotId: null,
      signal: new AbortController().signal,
      chat,
      now: () => (clock += 1200),
    });
    expect(run.results[0]!.stats).toEqual({ evalCount: 84, tokPerSec: 42, ms: 1200 });
    // No timings from the server is "we don't know", never a fabricated rate.
    expect(run.results[1]!.stats).toEqual({ evalCount: 0, tokPerSec: null, ms: 1200 });
  });
});

describe("a run against the one before it", () => {
  it("produces changed, same and error rows", async () => {
    const bench = threePrompts();
    const first = await runBench({
      bench,
      seed: 5,
      snapshotId: null,
      signal: new AbortController().signal,
      chat: scripted([answer("Use break."), answer("A key on a hook."), answer("It NPEs.")]).chat,
    });
    const second = await runBench({
      bench,
      seed: 5,
      snapshotId: null,
      signal: new AbortController().signal,
      chat: scripted([
        // Reworded — a diff, not a verdict.
        answer("Use break instead."),
        // Byte-identical.
        answer("A key on a hook."),
        new Error("context length exceeded"),
      ]).chat,
    });

    const rows = buildRows(bench, second, first);
    const byPrompt = Object.fromEntries(rows.map((r) => [r.prompt.text, r.state]));
    expect(byPrompt["Rewrite this loop to bail early."]).toBe("changed");
    expect(byPrompt["Explain a mutex to a Python programmer."]).toBe("same");
    expect(byPrompt["Summarise this stack trace."]).toBe("error");
    expect(tally(rows)).toEqual({ changed: 1, same: 1, error: 1, new: 0, pending: 0 });

    // Changed first: the point of a bench is that you read only what moved.
    expect(rows[0]!.state).toBe("changed");
  });
});
