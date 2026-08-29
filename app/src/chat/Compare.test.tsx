import "./test/localStorage";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { SESSIONS_STORAGE_KEY, type ChatSession } from "./sessions";
import { Sidebar } from "../ui/Sidebar";
import { RemudaProvider } from "../ui/state";
import { FakeClient, makeModel } from "../ui/test/FakeClient";

/**
 * A/B run (docs/SPEC-tuning.md T2) and the reply overflow menu (T6 1–3).
 *
 * The contract these are guarding, in order of how badly getting it wrong
 * would hurt:
 *
 *   1. **Lanes are sequential.** Two concurrent generations contend for the
 *      same VRAM, so each lane's tok/s would be measuring the contention
 *      rather than the configuration — the numbers would be wrong while
 *      looking entirely plausible, which is the worst kind of wrong.
 *   2. **One seed for the pair.** Two configurations under two seeds compare
 *      sampling noise.
 *   3. **One prompt, stored once.** The user asked one question.
 */

function models() {
  return [
    makeModel({ tag: "mistral:7b", isLoaded: true, capabilities: ["completion"], contextLength: 8192 }),
    makeModel({ tag: "llama3.1:8b", capabilities: ["completion"], contextLength: 8192 }),
  ];
}

function seedSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const session: ChatSession = {
    id: "s-seeded",
    title: "Support tone rewrite",
    model: "mistral:7b",
    messages: [],
    updatedAt: "2026-08-26T10:00:00.000Z",
    ...overrides,
  };
  window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify([session]));
  return session;
}

function renderChat(client: FakeClient) {
  return render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <Sidebar />
      <main>
        <ChatView />
      </main>
    </RemudaProvider>,
  );
}

async function openSeeded(client: FakeClient, title = "Support tone rewrite") {
  renderChat(client);
  await waitFor(() => expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled());
  fireEvent.click(screen.getByText(title));
}

/** Seed an empty session, open it, and turn compare on. */
async function openCompare(client: FakeClient) {
  seedSession();
  await openSeeded(client);
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  await act(async () => {});
}

function typeAndSend(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
}

/** The seed the compare bar says it pinned. */
function pinnedSeed(): number {
  const pin = screen.getByRole("button", { name: /pinned for this run/ });
  const match = /seed (\d+)/.exec(pin.textContent ?? "");
  expect(match).not.toBeNull();
  return Number(match?.[1]);
}

function stored(): ChatSession[] {
  return JSON.parse(window.localStorage.getItem(SESSIONS_STORAGE_KEY) ?? "[]") as ChatSession[];
}

/** Drive lane A to completion so lane B can start. */
async function finishLane(client: FakeClient, text: string, evalCount = 40) {
  await act(async () => {
    client.emitChat({ content: text, done: false });
  });
  await act(async () => {
    client.emitChat({
      content: "",
      done: true,
      stats: { evalCount, evalDurationNs: 1_000_000_000, totalDurationNs: 1_500_000_000 },
    });
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("A/B execution", () => {
  it("does not start lane B until lane A has finished", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);
    typeAndSend("Reply to this customer");
    await act(async () => {});

    // One call, not two. This is the whole contract: a second /api/chat here
    // would be a second generation against the same runner, and both lanes'
    // tok/s would then be measuring the contention between them.
    expect(client.chatCalls).toHaveLength(1);
    expect(screen.getByText("queued")).toBeInTheDocument();

    // Still one mid-stream — B doesn't sneak in once A produces tokens.
    await act(async () => {
      client.emitChat({ content: "Cancelled and refunded.", done: false });
    });
    await screen.findByText("Cancelled and refunded.");
    expect(client.chatCalls).toHaveLength(1);
    expect(screen.getByText("queued")).toBeInTheDocument();

    await act(async () => {
      client.emitChat({ content: "", done: true });
    });
    await waitFor(() => expect(client.chatCalls).toHaveLength(2));
    // queued → warming → tokens: B says which of the three it is in, rather
    // than sitting blank as though it had answered with nothing.
    expect(screen.queryByText("queued")).not.toBeInTheDocument();
    expect(screen.getByText(/warming up/)).toBeInTheDocument();
    await act(async () => {
      client.emitChat({ content: "I'm sorry to hear that.", done: false });
    });
    expect(await screen.findByText("I'm sorry to hear that.")).toBeInTheDocument();
    expect(screen.queryByText(/warming up/)).not.toBeInTheDocument();
  });

  it("stores one user message with no lane and one reply per lane", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);
    typeAndSend("Reply to this customer");
    await act(async () => {});
    await finishLane(client, "Terse answer.");
    await waitFor(() => expect(client.chatCalls).toHaveLength(2));
    await finishLane(client, "Warmer answer.");

    await waitFor(() => {
      const messages = stored()[0].messages;
      expect(messages).toHaveLength(3);
      // One prompt, asked once. Two copies would re-send the question twice
      // on the next turn and read as the user repeating themselves.
      expect(messages[0].role).toBe("user");
      expect(messages[0].lane).toBeUndefined();
      expect(messages[1]).toMatchObject({ role: "assistant", content: "Terse answer.", lane: "a" });
      expect(messages[2]).toMatchObject({ role: "assistant", content: "Warmer answer.", lane: "b" });
      // Persisted with ids, so a reload can still address either reply.
      expect(messages[1].id).toEqual(expect.stringMatching(/^m-/));
      expect(messages[2].id).toEqual(expect.stringMatching(/^m-/));
      expect(messages[1].id).not.toBe(messages[2].id);
    });
  });

  it("sends one pinned seed to both lanes", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);
    const seed = pinnedSeed();

    typeAndSend("Reply to this customer");
    await act(async () => {});
    await finishLane(client, "A.");
    await waitFor(() => expect(client.chatCalls).toHaveLength(2));

    // The same number, not merely two numbers. Different seeds would make
    // the comparison a measurement of sampling noise.
    expect(client.chatCalls[0].options?.seed).toBe(seed);
    expect(client.chatCalls[1].options?.seed).toBe(seed);
  });

  it("keeps a lane's overrides on that lane's request only", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);

    fireEvent.click(screen.getByRole("button", { name: "Lane A configuration" }));
    fireEvent.change(screen.getByLabelText("Lane A Temperature"), { target: { value: "0.9" } });
    fireEvent.click(screen.getByRole("button", { name: "Close run controls · Lane A" }));

    typeAndSend("Reply to this customer");
    await act(async () => {});
    await finishLane(client, "A.");
    await waitFor(() => expect(client.chatCalls).toHaveLength(2));

    expect(client.chatCalls[0].options?.temperature).toBe(0.9);
    expect(client.chatCalls[1].options?.temperature).toBeUndefined();
    // The chip names what the lane carries, so nothing about it is implicit.
    expect(screen.getByRole("button", { name: "Lane A configuration" })).toHaveTextContent(
      "1 override",
    );
  });

  it("mounts both lanes' run controls at once without colliding", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);

    fireEvent.click(screen.getByRole("button", { name: "Lane A configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "Lane B configuration" }));

    // Two dialogs, two sets of ids, two accessible names — the collision that
    // made an unscoped second instance unusable.
    const a = screen.getByLabelText("Lane A Temperature");
    const b = screen.getByLabelText("Lane B Temperature");
    expect(a.id).not.toBe(b.id);
    expect(document.querySelectorAll(`#${CSS.escape(a.id)}`)).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Run controls · Lane A" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Run controls · Lane B" })).toBeInTheDocument();

    fireEvent.change(a, { target: { value: "0.2" } });
    fireEvent.change(b, { target: { value: "1.4" } });

    typeAndSend("Reply to this customer");
    await act(async () => {});
    await finishLane(client, "A.");
    await waitFor(() => expect(client.chatCalls).toHaveLength(2));
    expect(client.chatCalls[0].options?.temperature).toBe(0.2);
    expect(client.chatCalls[1].options?.temperature).toBe(1.4);
  });

  it("cancels the whole run and keeps what streamed", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);
    typeAndSend("Reply to this customer");
    await act(async () => {});

    await act(async () => {
      client.emitChat({ content: "Half an ans", done: false });
    });
    await screen.findByText("Half an ans");

    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull());

    // Lane B never ran: cancel stops the pair, not just the streaming half.
    expect(client.chatCalls).toHaveLength(1);
    // …and the partial answer is kept (SPEC §5.3).
    expect(screen.getByText("Half an ans")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The guard cleared, so the next send works.
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("warns when the lanes name different models, and stays calm when they don't", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);
    expect(screen.getByText("same model · no swap")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Lane B model"), {
      target: { value: "llama3.1:8b" },
    });
    expect(await screen.findByText("swaps model between lanes · slower first run")).toBeInTheDocument();
  });

  it("marks the winner per metric and never scores the pair", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);
    typeAndSend("Reply to this customer");
    await act(async () => {});
    // A: 60 tok/s. B: 30 tok/s.
    await finishLane(client, "A.", 60);
    await waitFor(() => expect(client.chatCalls).toHaveLength(2));
    await finishLane(client, "B.", 30);

    await waitFor(() => {
      const laneA = document.querySelector(".lane.a .lanestats");
      const laneB = document.querySelector(".lane.b .lanestats");
      expect(laneA?.querySelector(".stat.win")).not.toBeNull();
      expect(laneB?.querySelector(".stat.win")).toBeNull();
    });
    // The cells sit in the same positions in both lanes, so the numbers are
    // comparable at a glance.
    const cells = (sel: string) =>
      Array.from(document.querySelectorAll(`${sel} .stat`)).map((n) =>
        (n.textContent ?? "").split(" ")[0],
      );
    expect(cells(".lane.a .lanestats")).toEqual(cells(".lane.b .lanestats"));
  });

  it("Keep this side collapses onto that lane and discards the other", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);
    fireEvent.change(screen.getByLabelText("Lane B model"), { target: { value: "llama3.1:8b" } });
    fireEvent.click(screen.getByRole("button", { name: "Lane B configuration" }));
    fireEvent.change(screen.getByLabelText("Lane B Top K"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Close run controls · Lane B" }));

    typeAndSend("Reply to this customer");
    await act(async () => {});
    await finishLane(client, "Terse answer.");
    await waitFor(() => expect(client.chatCalls).toHaveLength(2));
    await finishLane(client, "Warmer answer.");

    fireEvent.click(await screen.findByRole("button", { name: "Keep lane B" }));

    // The session adopts the kept lane whole: its model and its overrides.
    await waitFor(() => {
      const session = stored()[0];
      expect(session.model).toBe("llama3.1:8b");
      expect(session.options).toEqual({ topK: 7 });
      expect(session.compare).toBeUndefined();
      expect(session.messages.map((m) => m.content)).toEqual([
        "Reply to this customer",
        "Warmer answer.",
      ]);
      // Nothing left is one side of anything.
      expect(session.messages.every((m) => m.lane === undefined)).toBe(true);
    });
    // Back to a single-lane chat.
    expect(screen.queryByText("one prompt · both lanes")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("survives a reload with its lanes and its transcript intact", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);
    fireEvent.change(screen.getByLabelText("Lane B model"), { target: { value: "llama3.1:8b" } });
    typeAndSend("Reply to this customer");
    await act(async () => {});
    await finishLane(client, "Terse answer.");
    await waitFor(() => expect(client.chatCalls).toHaveLength(2));
    await finishLane(client, "Warmer answer.");
    await waitFor(() => expect(stored()[0].compare).toBeDefined());

    // Second boot on the same storage.
    cleanup();
    const reopened = new FakeClient({ models: models() });
    // The exchange retitled the session from its first user message.
    await openSeeded(reopened, "Reply to this customer");

    expect(await screen.findByText("Terse answer.")).toBeInTheDocument();
    expect(screen.getByText("Warmer answer.")).toBeInTheDocument();
    expect(screen.getAllByText("one prompt · both lanes")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Lane B configuration" })).toHaveTextContent(
      "llama3.1:8b",
    );
  });

  it("continues each lane's own conversation on the next turn", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);
    typeAndSend("First question");
    await act(async () => {});
    await finishLane(client, "A one.");
    await waitFor(() => expect(client.chatCalls).toHaveLength(2));
    await finishLane(client, "B one.");
    await screen.findByText("B one.");

    typeAndSend("Second question");
    await act(async () => {});
    await waitFor(() => expect(client.chatCalls).toHaveLength(3));

    // Lane A never said "B one." — sending it back as A's history would make
    // the second turn a comparison of two conversations rather than two
    // configurations, which is the failure this whole feature exists to avoid.
    expect(client.chatCalls[2].messages.map((m) => m.content)).toEqual([
      "First question",
      "A one.",
      "Second question",
    ]);
    await finishLane(client, "A two.");
    await waitFor(() => expect(client.chatCalls).toHaveLength(4));
    expect(client.chatCalls[3].messages.map((m) => m.content)).toEqual([
      "First question",
      "B one.",
      "Second question",
    ]);
    // Two turns, two rows — not one row with four replies in it.
    expect(screen.getAllByText("one prompt · both lanes")).toHaveLength(2);
  });

  it("blocks an ordinary send while a compare run is between its lanes", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);
    typeAndSend("Reply to this customer");
    await act(async () => {});
    expect(client.chatCalls).toHaveLength(1);

    // The composer is a Stop button for the whole run, not just for lane A.
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeInTheDocument();
    typeAndSend("Sneak this in");
    await act(async () => {});
    expect(client.chatCalls).toHaveLength(1);
  });
});

describe("reply overflow menu (T6 1–3)", () => {
  async function sendOnce(client: FakeClient, text = "Explain this regex") {
    await openSeeded(client);
    typeAndSend(text);
    await act(async () => {});
    await act(async () => {
      client.emitChat({ content: "It matches ISO timestamps.", done: true });
    });
    await screen.findByText("It matches ISO timestamps.");
  }

  it("copies the same request body the reply actually ran on", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    seedSession({ options: { temperature: 0.4, seed: 4417 } });
    const client = new FakeClient({ models: models() });
    await sendOnce(client);

    fireEvent.click(screen.getByRole("button", { name: "Reply actions for message 2" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as curl" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const command = writeText.mock.calls[0][0] as unknown as string;
    const body = JSON.parse(command.slice(command.indexOf("{"), command.lastIndexOf("}") + 1));
    const request = client.chatCalls[0];
    // Same model, same messages, same options as the request that produced it
    // — an export that only looked right would be worse than none.
    expect(body.model).toBe(request.tag);
    expect(body.options).toEqual({ temperature: 0.4, seed: 4417 });
    expect(body.messages).toEqual(
      request.messages.map((m) => ({ role: m.role, content: m.content })),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reply actions for message 2" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as ollama run" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls[1][0]).toContain("/set parameter seed 4417");
  });

  it("regenerates on the same seed, and on a new one", async () => {
    seedSession({ options: { temperature: 0.4, seed: 4417 } });
    const client = new FakeClient({ models: models() });
    await sendOnce(client);

    fireEvent.click(screen.getByRole("button", { name: "Reply actions for message 2" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate · same seed 4417" }));
    await act(async () => {});
    await act(async () => {
      client.emitChat({ content: "Another take.", done: true });
    });
    await screen.findByText("Another take.");
    // Holding the seed re-rolls the CONFIG, so the seed must be identical…
    expect(client.chatCalls).toHaveLength(2);
    expect(client.chatCalls[1].options).toEqual({ temperature: 0.4, seed: 4417 });
    // …and the reply stays one reply, re-rolled in place.
    expect(document.querySelectorAll(".msg.bot")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Reply actions for message 2" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate · new seed" }));
    await act(async () => {});
    expect(client.chatCalls).toHaveLength(3);
    // …while a new seed re-rolls the SAMPLING: everything else held.
    expect(client.chatCalls[2].options?.temperature).toBe(0.4);
    expect(client.chatCalls[2].options?.seed).not.toBe(4417);
    // Not written back into the session — a re-roll is not a settings change.
    await waitFor(() => expect(stored()[0].options).toEqual({ temperature: 0.4, seed: 4417 }));
  });

  it("has nothing to hold constant when no seed is set, and says so", async () => {
    seedSession();
    const client = new FakeClient({ models: models() });
    await sendOnce(client);

    fireEvent.click(screen.getByRole("button", { name: "Reply actions for message 2" }));
    // Not a silent no-op and not a fake "same seed": there is no seed.
    expect(screen.getByRole("menuitem", { name: "Regenerate · same seed none set" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Regenerate · new seed" })).toBeEnabled();
  });

  it("regenerates one lane against its own half of the conversation", async () => {
    const client = new FakeClient({ models: models() });
    await openCompare(client);
    typeAndSend("Reply to this customer");
    await act(async () => {});
    await finishLane(client, "Terse answer.");
    await waitFor(() => expect(client.chatCalls).toHaveLength(2));
    await finishLane(client, "Warmer answer.");

    fireEvent.click(
      screen.getByRole("button", { name: "Reply actions for lane A, turn 1" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /^Regenerate · same seed/ }));
    await act(async () => {});

    expect(client.chatCalls).toHaveLength(3);
    // Just the shared prompt — lane B's answer was never lane A's history.
    expect(client.chatCalls[2].messages).toEqual([
      { role: "user", content: "Reply to this customer" },
    ]);
    expect(screen.getByText("Warmer answer.")).toBeInTheDocument();
  });

  it("promotes a reply to SYSTEM without leaving anything saved", async () => {
    seedSession();
    const client = new FakeClient({
      models: models(),
      modelfile: "FROM mistral:7b\n",
    });
    await sendOnce(client);

    fireEvent.click(screen.getByRole("button", { name: "Reply actions for message 2" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Promote to SYSTEM" }));
    await act(async () => {});
    // The editor is the only place a change becomes permanent (SPEC §5.4).
    expect(client.createCalls).toHaveLength(0);
    expect(client.showCalls).toContain("mistral:7b");
  });
});

describe("a lane's own failure", () => {
  /** Fails the first chat call only, so lane A errors and lane B succeeds. */
  class FirstCallFails extends FakeClient {
    private calls = 0;

    override async *chat(
      ...args: Parameters<FakeClient["chat"]>
    ): ReturnType<FakeClient["chat"]> {
      this.calls += 1;
      if (this.calls === 1) {
        throw new Error("model 'mistral:7b' not found, try pulling it first");
      }
      yield* super.chat(...args);
    }
  }

  it("keeps lane A's error on screen after lane B starts and succeeds", async () => {
    const client = new FirstCallFails({ models: models() });
    await openCompare(client);
    typeAndSend("reply to this customer");

    // Lane A rejects immediately; lane B then streams to completion.
    await act(async () => {});
    await finishLane(client, "Cancelled and refunded.");

    // The bug this guards: lane B's runGeneration clears the single app-wide
    // streamError slot on entry, which used to discard lane A's explanation
    // and leave an empty bubble with no reason shown anywhere.
    expect(
      await screen.findByText(/not found, try pulling it first/),
    ).toBeInTheDocument();
    // And lane B's reply is unaffected by its sibling's failure.
    expect(screen.getByText("Cancelled and refunded.")).toBeInTheDocument();
  });
});
