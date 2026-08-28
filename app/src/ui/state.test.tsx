/**
 * Provider polling (SPEC.md §8, §9).
 *
 * The health poll used to only ask /api/version, and rebuilt the model list
 * solely on a disconnected→connected transition. That left Remuda blind to
 * anything that changed the store from outside — `ollama pull` in a
 * terminal, `ollama rm`, another client. These cover the cheap reconcile
 * that fixes it, and the cost guard that keeps it cheap.
 */
import "../chat/test/localStorage";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { RemudaProvider, useRemuda } from "./state";
import { FakeClient, makeModel } from "./test/FakeClient";
import type { RemudaContextValue } from "./state";

/** Renders one line per known base tag, plus the live connection state. */
function ModelList() {
  const { groups, status } = useRemuda();
  return (
    <>
      <span data-testid="conn">{status.connected ? "up" : "down"}</span>
      <ul aria-label="models">
        {groups.map((g) => (
          <li key={g.base.tag}>{g.base.tag}</li>
        ))}
      </ul>
    </>
  );
}

function renderWithPoll(client: FakeClient) {
  return render(
    <RemudaProvider client={client} pollIntervalMs={10}>
      <ModelList />
    </RemudaProvider>,
  );
}

describe("model reconcile on poll", () => {
  it("picks up a model pulled outside Remuda", async () => {
    const client = new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.2:latest" })],
    });
    renderWithPoll(client);

    await waitFor(() => expect(screen.getByText("llama3.2:latest")).toBeInTheDocument());
    expect(screen.queryByText("gemma2:2b")).not.toBeInTheDocument();

    // Simulate `ollama pull gemma2:2b` in a terminal: the store changes
    // without Remuda having initiated anything.
    client.models = [...client.models, makeModel({ tag: "gemma2:2b" })];

    await waitFor(() => expect(screen.getByText("gemma2:2b")).toBeInTheDocument());
  });

  it("drops a model removed outside Remuda", async () => {
    const client = new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.2:latest" }), makeModel({ tag: "gemma2:2b" })],
    });
    renderWithPoll(client);

    await waitFor(() => expect(screen.getByText("gemma2:2b")).toBeInTheDocument());

    client.models = client.models.filter((m) => m.tag !== "gemma2:2b");

    await waitFor(() => expect(screen.queryByText("gemma2:2b")).not.toBeInTheDocument());
  });

  it("notices a re-pull of the same tag", async () => {
    // The tag set is unchanged, so only modifiedAt distinguishes the two —
    // this is what the signature exists for.
    const client = new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.2:latest", modifiedAt: "2026-01-01T00:00:00Z" })],
    });
    renderWithPoll(client);

    await waitFor(() => expect(client.listGroupsCalls).toBe(1));

    client.models = [makeModel({ tag: "llama3.2:latest", modifiedAt: "2026-06-01T00:00:00Z" })];

    await waitFor(() => expect(client.listGroupsCalls).toBe(2));
  });

  it("does not re-run the /api/show sweep while nothing changes", async () => {
    const client = new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.2:latest" })],
    });
    renderWithPoll(client);

    await waitFor(() => expect(client.listGroupsCalls).toBe(1));

    // Several poll ticks (interval is 10ms) with a stable store.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(client.listGroupsCalls).toBe(1);
  });

  it("rebuilds from scratch after a reconnect", async () => {
    const client = new FakeClient({ connected: true, models: [makeModel({ tag: "llama3.2:latest" })] });
    renderWithPoll(client);

    await waitFor(() => expect(client.listGroupsCalls).toBe(1));

    // Wait for the outage to actually be *observed* by a poll tick — setting
    // the flag isn't enough, and asserting too early made this vacuous.
    client.failVersion = true;
    await waitFor(() => expect(screen.getByTestId("conn")).toHaveTextContent("down"));
    expect(client.listGroupsCalls).toBe(1);

    // Back up, same models: the signature was cleared on the outage, so we
    // re-sweep rather than trusting a snapshot from before it.
    client.failVersion = false;
    await waitFor(() => expect(screen.getByTestId("conn")).toHaveTextContent("up"));
    await waitFor(() => expect(client.listGroupsCalls).toBe(2));
  });

  it("leaves the groups identity alone when nothing loaded or unloaded", async () => {
    // The reconcile runs on every tick; if it rebuilt the array each time,
    // every consumer of `groups` would re-render twice a minute for nothing.
    const client = new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.2:latest" })],
    });

    const seen: unknown[] = [];
    function GroupsIdentity() {
      const { groups } = useRemuda();
      if (seen[seen.length - 1] !== groups) seen.push(groups);
      return null;
    }
    render(
      <RemudaProvider client={client} pollIntervalMs={10}>
        <GroupsIdentity />
      </RemudaProvider>,
    );

    await waitFor(() => expect(client.listGroupsCalls).toBe(1));
    const afterFirstSweep = seen.length;

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(seen.length).toBe(afterFirstSweep);
  });

  it("does not re-sweep every tick when the sweep keeps failing", async () => {
    // One bad /api/show is enough to reject the whole listGroups sweep. If
    // the signature were only claimed on success, every subsequent tick would
    // mismatch and launch another N-request sweep, forever and silently.
    const client = new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.2:latest" })],
      failListGroups: "fake: /api/show exploded",
    });
    renderWithPoll(client);

    await waitFor(() => expect(client.listGroupsCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(client.listGroupsCalls).toBe(1);
  });

  it("retries a failed sweep once the installed set actually changes", async () => {
    const client = new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.2:latest" })],
      failListGroups: "fake: /api/show exploded",
    });
    renderWithPoll(client);

    await waitFor(() => expect(client.listGroupsCalls).toBe(1));

    client.failListGroups = undefined;
    client.models = [...client.models, makeModel({ tag: "gemma2:2b" })];

    await waitFor(() => expect(screen.getByText("gemma2:2b")).toBeInTheDocument());
  });

  it("never runs two sweeps at once when one outlasts the poll interval", async () => {
    const client = new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.2:latest" })],
    });
    // Sweep takes far longer than the 10ms poll, so ticks pile up behind it.
    client.listGroupsDelayMs = 120;
    renderWithPoll(client);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(client.listGroupsCalls).toBe(1);
  });
});

/* ── runtime readout, chat options, thinking, images ────────────────────── */

/** Grabs the live context so a test can call into it directly. */
function captureContext(seen: { current: RemudaContextValue | null }) {
  return function Capture() {
    seen.current = useRemuda();
    return null;
  };
}

function renderContext(client: FakeClient, pollIntervalMs = 10) {
  const seen: { current: RemudaContextValue | null } = { current: null };
  const Capture = captureContext(seen);
  render(
    <RemudaProvider client={client} pollIntervalMs={pollIntervalMs}>
      <Capture />
    </RemudaProvider>,
  );
  return seen;
}

/** The context, asserted non-null — the provider always renders children. */
function ctx(seen: { current: RemudaContextValue | null }): RemudaContextValue {
  if (seen.current === null) throw new Error("provider never rendered");
  return seen.current;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("running (GET /api/ps readout)", () => {
  it("exposes the full readout and refreshes it from the existing poll", async () => {
    const client = new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
      running: [
        {
          tag: "llama3.1:8b",
          sizeBytes: 6_000_000_000,
          sizeVramBytes: 4_500_000_000,
          contextLength: 8192,
          expiresAt: "2026-08-26T12:05:00Z",
        },
      ],
    });
    const seen = renderContext(client);

    await waitFor(() => expect(ctx(seen).running).toHaveLength(1));
    expect(ctx(seen).running[0]).toEqual({
      tag: "llama3.1:8b",
      sizeBytes: 6_000_000_000,
      sizeVramBytes: 4_500_000_000,
      contextLength: 8192,
      expiresAt: "2026-08-26T12:05:00Z",
    });

    // Ollama dropped it after keep_alive: the next tick notices.
    client.running = [];
    await waitFor(() => expect(ctx(seen).running).toEqual([]));
  });

  it("costs the poll no standalone /api/ps request", async () => {
    const client = new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
    });
    renderContext(client);

    await waitFor(() => expect(client.listGroupsCalls).toBe(1));
    const afterFirstSweep = client.listRunningCalls;
    // Several more ticks with a stable store.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(client.listRunningCalls).toBe(afterFirstSweep);
  });

  it("keeps the array identity stable while the numbers don't move", async () => {
    const client = new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
    });
    const seen = renderContext(client);

    await waitFor(() => expect(ctx(seen).running).toHaveLength(1));
    const first = ctx(seen).running;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(ctx(seen).running).toBe(first);
  });

  it("empties the readout when the server goes away", async () => {
    const client = new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
    });
    const seen = renderContext(client);
    await waitFor(() => expect(ctx(seen).running).toHaveLength(1));

    client.failVersion = true;
    await waitFor(() => expect(ctx(seen).status.connected).toBe(false));
    // A stale residency list would read as fact; say nothing instead.
    expect(ctx(seen).running).toEqual([]);
  });
});

describe("chat: thinking, options and images", () => {
  /** A provider with one loaded model and an open session on it. */
  async function withSession(client: FakeClient) {
    const seen = renderContext(client, 1_000_000);
    await waitFor(() => expect(ctx(seen).activeModel?.variant).toBe("llama3.1:8b"));
    act(() => ctx(seen).newChat());
    await waitFor(() => expect(ctx(seen).activeSessionId).not.toBeNull());
    return seen;
  }

  function loadedClient(options: ConstructorParameters<typeof FakeClient>[0] = {}) {
    return new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
      ...options,
    });
  }

  it("accumulates thinking into its own field, never into content", async () => {
    const client = loadedClient({
      chatChunks: [
        { content: "", thinking: "weigh ", done: false },
        { content: "", thinking: "options", done: false },
        { content: "Use ", done: false },
        { content: "git reset.", done: true },
      ],
    });
    const seen = await withSession(client);

    await act(async () => {
      await ctx(seen).sendMessage("how do I undo a commit");
    });

    const session = ctx(seen).sessions[0];
    const reply = session.messages[session.messages.length - 1];
    expect(reply.role).toBe("assistant");
    expect(reply.content).toBe("Use git reset.");
    expect(reply.thinking).toBe("weigh options");
  });

  it("strips prior reasoning from the outbound history", async () => {
    const client = loadedClient({
      chatChunks: [{ content: "first", thinking: "hmm", done: true }],
    });
    const seen = await withSession(client);

    await act(async () => {
      await ctx(seen).sendMessage("one");
    });
    await act(async () => {
      await ctx(seen).sendMessage("two");
    });

    // Ollama does not take reasoning back as context — the second request
    // must carry the assistant's content and nothing else.
    expect(client.chatCalls[1].messages).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "first" },
      { role: "user", content: "two" },
    ]);
  });

  it("sends the session's think level and options on every request", async () => {
    const client = loadedClient({ chatChunks: [{ content: "ok", done: true }] });
    const seen = await withSession(client);
    const sessionId = ctx(seen).activeSessionId as string;

    act(() => {
      ctx(seen).setSessionThink(sessionId, "medium");
      ctx(seen).setSessionOptions(sessionId, { temperature: 0.2, numCtx: 4096 });
    });

    await act(async () => {
      await ctx(seen).sendMessage("one");
    });
    await act(async () => {
      await ctx(seen).sendMessage("two");
    });

    expect(client.chatCalls).toHaveLength(2);
    for (const call of client.chatCalls) {
      expect(call.think).toBe("medium");
      expect(call.options).toEqual({ temperature: 0.2, numCtx: 4096 });
    }
    // Persisted with the session (SPEC §6).
    expect(ctx(seen).sessions[0].think).toBe("medium");
    expect(ctx(seen).sessions[0].options).toEqual({ temperature: 0.2, numCtx: 4096 });
  });

  it("leaves think and options undefined when the session sets neither", async () => {
    const client = loadedClient({ chatChunks: [{ content: "ok", done: true }] });
    const seen = await withSession(client);
    await act(async () => {
      await ctx(seen).sendMessage("hi");
    });
    expect(client.chatCalls[0].think).toBeUndefined();
    expect(client.chatCalls[0].options).toBeUndefined();
  });

  it("sends images on the wire, keeps thumbs for the transcript, and holds thumbs alone after a reload", async () => {
    const client = loadedClient({ chatChunks: [{ content: "a cat", done: true }] });
    const seen = await withSession(client);

    await act(async () => {
      await ctx(seen).sendMessage("what is this", ["QkFTRTY0"], [
        "data:image/png;base64,QkFTRTY0",
      ]);
    });

    expect(client.chatCalls[0].messages).toEqual([
      { role: "user", content: "what is this", images: ["QkFTRTY0"] },
    ]);
    const stored = ctx(seen).sessions[0].messages[0];
    expect(stored.images).toEqual(["QkFTRTY0"]);
    expect(stored.imageThumbs).toEqual(["data:image/png;base64,QkFTRTY0"]);
  });

  it("still takes a single argument — existing callers are unaffected", async () => {
    const client = loadedClient({ chatChunks: [{ content: "hi", done: true }] });
    const seen = await withSession(client);
    await act(async () => {
      await ctx(seen).sendMessage("plain text only");
    });
    expect(client.chatCalls[0].messages).toEqual([
      { role: "user", content: "plain text only" },
    ]);
  });

  it("derives the full timing breakdown, keeping tokPerSec as it was", async () => {
    const client = loadedClient({
      chatChunks: [
        {
          content: "done",
          done: true,
          stats: {
            evalCount: 42,
            evalDurationNs: 2_000_000_000,
            promptEvalCount: 11,
            promptEvalDurationNs: 500_000_000,
            loadDurationNs: 1_500_000_000,
            totalDurationNs: 4_000_000_000,
          },
        },
      ],
    });
    const seen = await withSession(client);
    await act(async () => {
      await ctx(seen).sendMessage("hi");
    });

    const stats = ctx(seen).lastStats;
    expect(stats?.sessionId).toBe(ctx(seen).sessions[0].id);
    expect(stats?.tokPerSec).toBe(21);
    expect(stats?.evalCount).toBe(42);
    expect(stats?.promptTokPerSec).toBe(22);
    expect(stats?.promptEvalCount).toBe(11);
    expect(stats?.contextTokens).toBe(53);
    expect(stats?.loadMs).toBe(1500);
    expect(stats?.totalMs).toBe(4000);
  });

  it("reports null, not zero, for timings an older server omits", async () => {
    const client = loadedClient({
      chatChunks: [
        { content: "done", done: true, stats: { evalCount: 8, evalDurationNs: 1_000_000_000 } },
      ],
    });
    const seen = await withSession(client);
    await act(async () => {
      await ctx(seen).sendMessage("hi");
    });

    const stats = ctx(seen).lastStats;
    expect(stats?.tokPerSec).toBe(8);
    expect(stats?.promptTokPerSec).toBeNull();
    expect(stats?.promptEvalCount).toBeNull();
    expect(stats?.contextTokens).toBeNull();
    expect(stats?.loadMs).toBeNull();
    expect(stats?.totalMs).toBeNull();
  });
});

/**
 * The send path's seam (SPEC-tuning T2, wave 3a).
 *
 * Nothing here is user-visible yet: `sendMessage` still creates one reply
 * and the §8 one-at-a-time guard still refuses a second send. What changed
 * is that a reply is now addressed by message id rather than by "last in the
 * array", and that more than one run can be tracked at once — so these
 * exercise the seam directly, which is the only way to reach it today.
 */
describe("runGeneration — routing a reply to a named message", () => {
  function loadedClient(options: ConstructorParameters<typeof FakeClient>[0] = {}) {
    return new FakeClient({
      connected: true,
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })],
      ...options,
    });
  }

  async function withSession(client: FakeClient) {
    const seen = renderContext(client, 1_000_000);
    await waitFor(() => expect(ctx(seen).activeModel?.variant).toBe("llama3.1:8b"));
    act(() => ctx(seen).newChat());
    await waitFor(() => expect(ctx(seen).activeSessionId).not.toBeNull());
    return seen;
  }

  /** Two completed exchanges: [user, assistant, user, assistant]. */
  async function withTwoExchanges(client: FakeClient) {
    const seen = await withSession(client);
    await act(async () => {
      await ctx(seen).sendMessage("first");
    });
    await act(async () => {
      await ctx(seen).sendMessage("second");
    });
    return seen;
  }

  it("appends to the message with the matching id, not to the last one", async () => {
    // The regression this refactor exists to prevent. The target sits at
    // index 1 with two messages after it; index-from-the-end would have put
    // every token in the wrong bubble.
    const client = loadedClient({ chatChunks: [{ content: "", done: true }] });
    const seen = await withTwoExchanges(client);

    const before = ctx(seen).sessions[0];
    expect(before.messages).toHaveLength(4);
    const targetMessageId = before.messages[1].id as string;
    const lastId = before.messages[3].id as string;
    expect(targetMessageId).toBeDefined();
    expect(targetMessageId).not.toBe(lastId);

    client.chatChunks = [
      { content: "re", thinking: "why ", done: false },
      { content: "run", thinking: "not", done: true },
    ];
    await act(async () => {
      await ctx(seen).runGeneration({
        sessionId: before.id,
        targetMessageId,
        model: before.model,
        messages: [{ role: "user", content: "first" }],
        signal: new AbortController().signal,
      });
    });

    const after = ctx(seen).sessions[0];
    expect(after.messages).toHaveLength(4);
    expect(after.messages[1].content).toBe("rerun");
    expect(after.messages[1].thinking).toBe("why not");
    // The last message — the one the old code would have written into — is
    // untouched, ids and all.
    expect(after.messages[3].content).toBe("");
    expect(after.messages[3].thinking).toBeUndefined();
    expect(after.messages[3].id).toBe(lastId);
  });

  it("takes model, options and think from its arguments, never from the session", async () => {
    const client = loadedClient({ chatChunks: [{ content: "ok", done: true }] });
    const seen = await withSession(client);
    const sessionId = ctx(seen).activeSessionId as string;
    act(() => {
      ctx(seen).setSessionThink(sessionId, "low");
      ctx(seen).setSessionOptions(sessionId, { temperature: 0.1 });
    });
    await act(async () => {
      await ctx(seen).sendMessage("hi");
    });
    const targetMessageId = ctx(seen).sessions[0].messages[1].id as string;

    await act(async () => {
      await ctx(seen).runGeneration({
        sessionId,
        targetMessageId,
        model: "some-other:tag",
        messages: [{ role: "user", content: "hi" }],
        options: { temperature: 0.9, seed: 4417 },
        think: "high",
        signal: new AbortController().signal,
      });
    });

    const call = client.chatCalls[client.chatCalls.length - 1];
    expect(call.tag).toBe("some-other:tag");
    expect(call.options).toEqual({ temperature: 0.9, seed: 4417 });
    expect(call.think).toBe("high");
    // The session's own settings are unchanged by a run that ignored them.
    expect(ctx(seen).sessions[0].options).toEqual({ temperature: 0.1 });
    expect(ctx(seen).sessions[0].think).toBe("low");
  });

  it("records the target message id alongside the session on lastStats", async () => {
    const client = loadedClient({
      chatChunks: [
        { content: "ok", done: true, stats: { evalCount: 10, evalDurationNs: 1_000_000_000 } },
      ],
    });
    const seen = await withSession(client);
    await act(async () => {
      await ctx(seen).sendMessage("hi");
    });
    const stats = ctx(seen).lastStats;
    // The existing contract is untouched — StatsStrip reads these two.
    expect(stats?.sessionId).toBe(ctx(seen).sessions[0].id);
    expect(stats?.tokPerSec).toBe(10);
    // …and the reply is now named, so two lanes could tell theirs apart.
    expect(stats?.messageId).toBe(ctx(seen).sessions[0].messages[1].id);
  });

  it("is a no-op for a target id that isn't in the session, and never falls back to the last message", async () => {
    const client = loadedClient({ chatChunks: [{ content: "", done: true }] });
    const seen = await withTwoExchanges(client);
    const before = ctx(seen).sessions[0];
    const snapshot = JSON.parse(JSON.stringify(before.messages)) as unknown;

    client.chatChunks = [{ content: "orphan tokens", done: true }];
    await act(async () => {
      await ctx(seen).runGeneration({
        sessionId: before.id,
        targetMessageId: "m-does-not-exist",
        model: before.model,
        messages: [{ role: "user", content: "first" }],
        signal: new AbortController().signal,
      });
    });

    const after = ctx(seen).sessions[0];
    expect(after.messages).toEqual(snapshot);
    expect(after.messages.some((m) => m.content.includes("orphan"))).toBe(false);
    // Not an error either — a stale target is a dropped update, not a failure.
    expect(ctx(seen).streamError).toBeNull();
    expect(ctx(seen).streamingSessionId).toBeNull();
  });

  it("runs two targets in one session without either landing in the other", async () => {
    // What A/B will do: one session, two replies, two option bags. Both run
    // at once here specifically so a shared append target would show up as
    // one doubled bubble and one empty one.
    const client = loadedClient({ chatChunks: [{ content: "", done: true }] });
    const seen = await withTwoExchanges(client);
    const session = ctx(seen).sessions[0];
    const laneA = session.messages[1].id as string;
    const laneB = session.messages[3].id as string;

    client.chatChunks = [
      { content: "x", done: false },
      { content: "y", done: true },
    ];
    await act(async () => {
      await Promise.all([
        ctx(seen).runGeneration({
          sessionId: session.id,
          targetMessageId: laneA,
          model: session.model,
          messages: [{ role: "user", content: "same prompt" }],
          options: { temperature: 0 },
          signal: new AbortController().signal,
        }),
        ctx(seen).runGeneration({
          sessionId: session.id,
          targetMessageId: laneB,
          model: session.model,
          messages: [{ role: "user", content: "same prompt" }],
          options: { temperature: 1 },
          signal: new AbortController().signal,
        }),
      ]);
    });

    const after = ctx(seen).sessions[0];
    expect(after.messages[1].content).toBe("xy");
    expect(after.messages[3].content).toBe("xy");
    // Two option sets out of one session — the thing session.options could
    // not express.
    const [a, b] = client.chatCalls.slice(-2);
    expect([a.options, b.options]).toEqual(
      expect.arrayContaining([{ temperature: 0 }, { temperature: 1 }]),
    );
    expect(ctx(seen).streamingSessionId).toBeNull();
  });
});

describe("the stream map — cancel, delete and the §8 guard", () => {
  function loadedClient(models = [makeModel({ tag: "llama3.1:8b", isLoaded: true })]) {
    return new FakeClient({ connected: true, models });
  }

  async function withSession(client: FakeClient) {
    const seen = renderContext(client, 1_000_000);
    await waitFor(() => expect(ctx(seen).activeModel?.variant).toBe("llama3.1:8b"));
    act(() => ctx(seen).newChat());
    await waitFor(() => expect(ctx(seen).activeSessionId).not.toBeNull());
    return seen;
  }

  it("cancelGeneration aborts the in-flight run, keeps the partial reply and empties the map", async () => {
    const client = loadedClient();
    const seen = await withSession(client);
    let pending!: Promise<void>;
    await act(async () => {
      pending = ctx(seen).sendMessage("tell me a story");
      await Promise.resolve();
    });
    const sessionId = ctx(seen).sessions[0].id;
    expect(ctx(seen).streamingSessionId).toBe(sessionId);

    await act(async () => {
      client.emitChat({ content: "Once upon", done: false });
      await Promise.resolve();
    });

    act(() => ctx(seen).cancelGeneration());
    await act(async () => {
      await pending;
    });

    expect(ctx(seen).streamingSessionId).toBeNull();
    expect(ctx(seen).sessions[0].messages[1].content).toBe("Once upon");
    expect(ctx(seen).streamError).toBeNull();

    // The map is empty, not merely "the slot was nulled": the §8 guard reads
    // its size, so a send that goes through is the proof.
    client.chatChunks = [{ content: " again", done: true }];
    await act(async () => {
      await ctx(seen).sendMessage("more");
    });
    expect(client.chatCalls).toHaveLength(2);
  });

  it("deleteSession aborts only its own session's run and leaves another's alone", async () => {
    const client = loadedClient();
    const seen = await withSession(client);
    const sessionA = ctx(seen).activeSessionId as string;
    act(() => ctx(seen).newChat());
    await waitFor(() => expect(ctx(seen).sessions).toHaveLength(2));
    const sessionB = ctx(seen).activeSessionId as string;
    expect(sessionB).not.toBe(sessionA);

    // Two runs in flight at once — reachable only through the seam today,
    // which is the point: deleteSession has to pick one out of the map.
    const runA = new AbortController();
    const runB = new AbortController();
    let pendingA!: Promise<void>;
    let pendingB!: Promise<void>;
    await act(async () => {
      pendingA = ctx(seen).runGeneration({
        sessionId: sessionA,
        targetMessageId: "m-a",
        model: "llama3.1:8b",
        messages: [{ role: "user", content: "a" }],
        signal: runA.signal,
      });
      pendingB = ctx(seen).runGeneration({
        sessionId: sessionB,
        targetMessageId: "m-b",
        model: "llama3.1:8b",
        messages: [{ role: "user", content: "b" }],
        signal: runB.signal,
      });
      await Promise.resolve();
    });
    expect(ctx(seen).streamingSessionId).toBe(sessionA);

    await act(async () => {
      ctx(seen).deleteSession(sessionA);
      await pendingA;
    });

    // A is gone and its run has ended; B's is still open, which is what the
    // readout now says instead of "idle".
    expect(ctx(seen).sessions.map((s) => s.id)).toEqual([sessionB]);
    expect(ctx(seen).streamingSessionId).toBe(sessionB);
    expect(runB.signal.aborted).toBe(false);

    await act(async () => {
      ctx(seen).cancelGeneration();
      await pendingB;
    });
    expect(ctx(seen).streamingSessionId).toBeNull();
    expect(ctx(seen).streamError).toBeNull();
  });

  it("still refuses a second send while anything is in flight (SPEC §8 is unchanged)", async () => {
    const client = loadedClient();
    const seen = await withSession(client);
    let pending!: Promise<void>;
    await act(async () => {
      pending = ctx(seen).sendMessage("first");
      await Promise.resolve();
    });
    expect(client.chatCalls).toHaveLength(1);

    await act(async () => {
      await ctx(seen).sendMessage("second");
    });
    // No second request, and no second pair of messages appended.
    expect(client.chatCalls).toHaveLength(1);
    expect(ctx(seen).sessions[0].messages).toHaveLength(2);

    await act(async () => {
      client.emitChat({ content: "done", done: true });
      await pending;
    });
    expect(ctx(seen).streamingSessionId).toBeNull();
  });
});
