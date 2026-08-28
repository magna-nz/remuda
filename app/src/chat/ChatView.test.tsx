import "./test/localStorage";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import { SESSIONS_STORAGE_KEY, type ChatSession } from "./sessions";
import { Sidebar } from "../ui/Sidebar";
import { EditorView } from "../editor/EditorView";
import { RemudaProvider } from "../ui/state";
import { FakeClient, makeModel } from "../ui/test/FakeClient";

function fixtureModels() {
  return [
    makeModel({ tag: "llama3.1:8b", isLoaded: true }),
    makeModel({ tag: "mistral:7b" }),
  ];
}

/** A loaded model whose capabilities a test wants to pin exactly. */
function capableModels(capabilities: string[], tag = "mistral:7b") {
  return [makeModel({ tag, isLoaded: true, capabilities, contextLength: 8192 })];
}

function seedSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const session: ChatSession = {
    id: "s-seeded",
    title: "Explain this regex",
    model: "mistral:7b",
    messages: [
      { role: "user", content: "Explain this regex" },
      { role: "assistant", content: "It matches ISO timestamps." },
    ],
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

/** Wait for the first health check to populate the model list. */
async function untilLoaded() {
  await waitFor(() => expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled());
}

/** Render, wait for the model list, and open the seeded session. */
async function openSeeded(client: FakeClient, title = "Explain this regex") {
  renderChat(client);
  await untilLoaded();
  fireEvent.click(screen.getByText(title));
}

async function startChatAndSend(client: FakeClient, text: string) {
  renderChat(client);
  await untilLoaded();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
  // Let sendMessage reach its first await on the stream.
  await act(async () => {});
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("ChatView", () => {
  it("shows the no-session placeholder until a chat is opened", async () => {
    renderChat(new FakeClient({ models: fixtureModels() }));
    expect(screen.getByText("Load a model, then start a chat")).toBeInTheDocument();
  });

  it("newChat binds the loaded model; blocked when nothing is loaded", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    renderChat(client);
    await untilLoaded();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    // Fresh-session empty state names the model it will test.
    const main = screen.getByText("Send a message to test", { exact: false });
    expect(within(main).getByText("llama3.1:8b")).toBeInTheDocument();
    // The session persists (debounced ~300ms), bound to the loaded variant
    // (SPEC §5.2, §6).
    await waitFor(
      () => {
        const stored = JSON.parse(window.localStorage.getItem(SESSIONS_STORAGE_KEY) ?? "[]");
        expect(stored).toHaveLength(1);
        expect(stored[0].model).toBe("llama3.1:8b");
        expect(stored[0].title).toBe("New chat");
      },
      { timeout: 1500 },
    );
  });

  it("disables New chat with a hint while nothing is loaded", async () => {
    const client = new FakeClient({ models: [makeModel({ tag: "llama3.1:8b" })] });
    renderChat(client);
    // Give the health check time to land; the button must stay disabled.
    await screen.findByText("No chats yet — load a model, then start one.");
    const button = screen.getByRole("button", { name: "New chat" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Load a model first");
    fireEvent.click(button);
    expect(window.localStorage.getItem(SESSIONS_STORAGE_KEY) ?? "[]").toBe("[]");
  });

  it("streams chunks into the assistant bubble, warming first, tok/s after", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await startChatAndSend(client, "Say hello");

    // The user bubble landed and the reply is warming (SPEC §9).
    const log = within(screen.getByRole("main"));
    expect(log.getByText("Say hello")).toBeInTheDocument();
    expect(log.getByText(/warming up/)).toBeInTheDocument();
    expect(client.chatCalls).toHaveLength(1);
    expect(client.chatCalls[0].tag).toBe("llama3.1:8b");
    expect(client.chatCalls[0].messages).toEqual([{ role: "user", content: "Say hello" }]);

    await act(async () => {
      client.emitChat({ content: "Hel", done: false });
    });
    expect(await screen.findByText("Hel")).toBeInTheDocument();
    expect(screen.queryByText(/warming up/)).not.toBeInTheDocument();

    await act(async () => {
      client.emitChat({ content: "lo!", done: false });
    });
    expect(await screen.findByText("Hello!")).toBeInTheDocument();

    await act(async () => {
      client.emitChat({ content: "", done: true, stats: { evalCount: 90, evalDurationNs: 2_000_000_000 } });
    });
    // 90 tokens / 2s = 45 tok/s, shown once the reply completes. The bare
    // readout is now the Generation cell of the timings strip (§4), whose
    // unit sits in its own element — hence textContent rather than getByText.
    expect(await screen.findByLabelText("Reply timings")).toHaveTextContent("45 tok/s");
    // The exchange titled the session from the first user message.
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(SESSIONS_STORAGE_KEY) ?? "[]");
      expect(stored[0].title).toBe("Say hello");
      expect(stored[0].messages).toEqual([
        { role: "user", content: "Say hello" },
        { role: "assistant", content: "Hello!" },
      ]);
    });
  });

  it("Shift+Enter newlines instead of sending", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    renderChat(client);
    await untilLoaded();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "line one" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter", shiftKey: true });
    await act(async () => {});
    expect(client.chatCalls).toHaveLength(0);
  });

  it("enforces one streamed generation at a time (SPEC §8)", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await startChatAndSend(client, "First message");

    // While streaming, the send affordance is Stop and Enter is inert.
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Second message" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await act(async () => {});
    expect(client.chatCalls).toHaveLength(1);
    // No second user bubble appeared; the draft stays in the composer.
    expect(document.querySelectorAll(".msg.user")).toHaveLength(1);
    expect(screen.getByLabelText("Message")).toHaveValue("Second message");

    await act(async () => {
      client.emitChat({ content: "done now", done: true });
    });
    await screen.findByRole("button", { name: "Send" });
  });

  it("deleting the streaming session aborts its generation and clears the guard", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await startChatAndSend(client, "Tell me a story");

    await act(async () => {
      client.emitChat({ content: "Once upon", done: false });
    });
    await screen.findByText("Once upon");

    // Delete the session that is actively streaming (title is the first
    // user message). The in-flight generation must abort, not orphan.
    fireEvent.click(screen.getByRole("button", { name: "Delete Tell me a story" }));
    await waitFor(() => expect(screen.queryByText("Once upon")).not.toBeInTheDocument());

    // Guard cleared: a fresh session can stream again immediately.
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "again" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await act(async () => {});
    expect(client.chatCalls).toHaveLength(2);
    await act(async () => {
      client.emitChat({ content: "done!", done: true });
    });
    await screen.findByText("done!");
  });

  it("cancel aborts the stream and keeps the partial reply", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await startChatAndSend(client, "Tell me a story");

    await act(async () => {
      client.emitChat({ content: "Once upon", done: false });
    });
    await screen.findByText("Once upon");

    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    await screen.findByRole("button", { name: "Send" });
    // Partial text survives the abort (SPEC §5.3), and no error is shown.
    expect(screen.getByText("Once upon")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // The guard cleared: a new message can stream again.
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "again" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await act(async () => {});
    expect(client.chatCalls).toHaveLength(2);
    await act(async () => {
      client.emitChat({ content: "", done: true });
    });
  });

  it("shows the unloaded banner for a session whose model isn't loaded; Load now loads it", async () => {
    seedSession({ model: "mistral:7b" });
    const client = new FakeClient({ models: fixtureModels() });
    renderChat(client);
    await untilLoaded();
    fireEvent.click(screen.getByText("Explain this regex"));

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(
      "mistral:7b isn’t loaded — in memory: llama3.1:8b. Load it to continue this chat.",
    );

    fireEvent.click(within(banner).getByRole("button", { name: "Load now" }));
    await waitFor(() =>
      expect(client.loadCalls).toEqual([{ tag: "mistral:7b", keepAlive: "5m" }]),
    );
    // load() refreshes /api/ps, so the banner clears without swapping models.
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("names 'nothing' when no model is loaded at all", async () => {
    seedSession({ model: "mistral:7b" });
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b" }), makeModel({ tag: "mistral:7b" })],
    });
    renderChat(client);
    await screen.findByText("Explain this regex");
    fireEvent.click(screen.getByText("Explain this regex"));
    expect(screen.getByRole("status")).toHaveTextContent("in memory: nothing");
  });

  it("sending while unloaded is allowed; the banner clears once the model registers as loaded", async () => {
    seedSession({ model: "mistral:7b" });
    const client = new FakeClient({
      models: fixtureModels(),
      // Scripted reply: Ollama loads mistral on demand during the exchange.
      chatChunks: [
        { content: "Sure.", done: false },
        { content: "", done: true },
      ],
    });
    renderChat(client);
    await untilLoaded();
    fireEvent.click(screen.getByText("Explain this regex"));
    expect(screen.getByRole("status")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Go on" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });

    await screen.findByText("Sure.");
    expect(client.chatCalls[0].tag).toBe("mistral:7b");
    // After the first completed reply, /api/ps is re-checked and shows it loaded.
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
  // ---- §3 thinking (mockup-proposals §03) ----

  it("renders reasoning outside the assistant bubble, collapsed by default", async () => {
    seedSession({
      messages: [
        { role: "user", content: "Explain this regex" },
        {
          role: "assistant",
          content: "It matches ISO timestamps.",
          thinking: "The anchors are the load-bearing part here.",
        },
      ],
    });
    await openSeeded(new FakeClient({ models: capableModels(["completion", "thinking"]) }));

    // Structurally separate: the block is a sibling of the bubble, not inside
    // it — copying the reply must not drag the reasoning along.
    expect(document.querySelector(".bubble .think")).toBeNull();
    expect(document.querySelector(".msg.bot .col > .think")).not.toBeNull();
    expect(screen.getByText("It matches ISO timestamps.")).not.toHaveTextContent("load-bearing");

    // Collapsed by default, and a restored session gets a neutral header
    // rather than an invented duration.
    const header = screen.getByRole("button", { name: "Reasoning" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/load-bearing/)).not.toBeInTheDocument();

    fireEvent.click(header);
    expect(screen.getByText(/load-bearing/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reasoning" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("streams reasoning live, expanded, without ever reaching the bubble", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await startChatAndSend(client, "Which sort?");

    await act(async () => {
      client.emitChat({ content: "", thinking: "Mostly-sorted is the word.", done: false });
    });
    // Live: expanded, headed "Thinking… Xs".
    expect(await screen.findByText(/Mostly-sorted is the word\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Thinking…/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await act(async () => {
      client.emitChat({ content: "Timsort.", done: true });
    });
    const bubble = await screen.findByText("Timsort.");
    expect(bubble).not.toHaveTextContent("Mostly-sorted");
    // Reasoning is never sent back as context, so nothing merged it into
    // content on the way to storage either.
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(SESSIONS_STORAGE_KEY) ?? "[]");
      expect(stored[0].messages[1]).toEqual({
        role: "assistant",
        content: "Timsort.",
        thinking: "Mostly-sorted is the word.",
      });
    });
  });

  it("shows the think control only for a thinking-capable model, and sends the level", async () => {
    seedSession();
    const client = new FakeClient({ models: capableModels(["completion", "thinking"]) });
    await openSeeded(client);

    const seg = screen.getByRole("group", { name: "Think" });
    expect(within(seg).getByRole("button", { name: "off" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(seg).getByRole("button", { name: "med" }));
    expect(within(seg).getByRole("button", { name: "med" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Go on" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await act(async () => {});
    expect(client.chatCalls[0].think).toBe("medium");
  });

  it("hides the think control for a model without the thinking capability", async () => {
    seedSession();
    await openSeeded(new FakeClient({ models: capableModels(["completion"]) }));
    expect(screen.queryByRole("group", { name: "Think" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
  });

  // ---- §4 run controls + timings (mockup-proposals §04) ----

  it("per-session run-control overrides reach the request and count on the pill", async () => {
    seedSession();
    const client = new FakeClient({ models: capableModels(["completion"]) });
    await openSeeded(client);

    fireEvent.click(screen.getByRole("button", { name: "Run controls" }));
    fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "0.9" } });
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "42" } });
    // The pill takes an accent style and names the count.
    const pill = await screen.findByRole("button", { name: "Run controls · 2 overridden" });
    expect(pill).toHaveClass("dirty");

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Again" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await act(async () => {});
    expect(client.chatCalls[0].options).toEqual({ temperature: 0.9, seed: 42 });

    // Overrides are per-session settings, never written to the Modelfile.
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(SESSIONS_STORAGE_KEY) ?? "[]");
      expect(stored[0].options).toEqual({ temperature: 0.9, seed: 42 });
    });
    expect(client.createCalls).toHaveLength(0);
  });

  it("Reset to Modelfile clears every override", async () => {
    seedSession({ options: { temperature: 0.9, topK: 12 } });
    await openSeeded(new FakeClient({ models: capableModels(["completion"]) }));

    fireEvent.click(screen.getByRole("button", { name: "Run controls · 2 overridden" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to Modelfile" }));
    expect(await screen.findByRole("button", { name: "Run controls" })).not.toHaveClass("dirty");
  });

  it("warns that num_ctx reloads the model, and only once it differs", async () => {
    seedSession();
    await openSeeded(new FakeClient({ models: capableModels(["completion"]) }));

    fireEvent.click(screen.getByRole("button", { name: "Run controls" }));
    // Inherited (8 192, from /api/show) — nothing to warn about yet.
    expect(screen.getByLabelText("Context length")).toHaveValue("8192");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Context length"), { target: { value: "16384" } });
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("Context length reloads the model.");
    expect(warning).toHaveTextContent(/restarts the runner/);

    // And it outlives the popover: the composer strip carries it too, since
    // that is where you are when the reload actually happens.
    fireEvent.click(screen.getByRole("button", { name: "Close run controls" }));
    expect(screen.queryByRole("dialog", { name: "Run controls" })).not.toBeInTheDocument();
    expect(screen.getByText(/num_ctx 16 384 — the next message reloads the model/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run controls · 1 overridden" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset Context length" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByText(/reloads the model/)).not.toBeInTheDocument();
  });

  it("renders — for timings the server didn't report, never NaN", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await startChatAndSend(client, "Say hello");
    await act(async () => {
      client.emitChat({
        content: "Hi.",
        done: true,
        stats: { evalCount: 90, evalDurationNs: 2_000_000_000 },
      });
    });

    const strip = await screen.findByLabelText("Reply timings");
    expect(strip).toHaveTextContent("45 tok/s");
    expect(strip).not.toHaveTextContent("NaN");
    // Prompt eval, load, total and context all came back absent.
    expect(within(strip).getAllByText("—")).toHaveLength(4);
  });

  it("renders every timing the server does report", async () => {
    const client = new FakeClient({ models: fixtureModels() });
    await startChatAndSend(client, "Say hello");
    await act(async () => {
      client.emitChat({
        content: "Hi.",
        done: true,
        stats: {
          evalCount: 90,
          evalDurationNs: 2_000_000_000,
          promptEvalCount: 1_114,
          promptEvalDurationNs: 1_000_000_000,
          loadDurationNs: 0,
          totalDurationNs: 2_410_000_000,
        },
      });
    });

    const strip = await screen.findByLabelText("Reply timings");
    expect(strip).toHaveTextContent("1 114 tok/s");
    expect(strip).toHaveTextContent("0.00 s");
    expect(strip).toHaveTextContent("2.41 s");
    // Context used = prompt + generated, against the model's trained window.
    expect(strip).toHaveTextContent("1 204 / 8 192");
  });

  // ---- §5a vision (mockup-proposals §05) ----

  it("offers the paperclip only for a vision-capable model", async () => {
    seedSession();
    await openSeeded(new FakeClient({ models: capableModels(["completion", "vision"]) }));
    expect(screen.getByRole("button", { name: "Attach an image" })).toBeInTheDocument();
  });

  it("hides the paperclip for a model without vision", async () => {
    seedSession();
    await openSeeded(new FakeClient({ models: capableModels(["completion"]) }));
    expect(screen.queryByRole("button", { name: "Attach an image" })).not.toBeInTheDocument();
  });

  it("marks a restored attachment as thumbnail-only — the original wasn't persisted", async () => {
    seedSession({
      messages: [
        {
          role: "user",
          content: "Which layout is clearer?",
          imageThumbs: ["data:image/jpeg;base64,AAAA"],
        },
        { role: "assistant", content: "The second." },
      ],
    });
    await openSeeded(
      new FakeClient({ models: capableModels(["completion", "vision"]) }),
      "Explain this regex",
    );

    const thumb = document.querySelector(".msg.user .att .thumb");
    expect(thumb).not.toBeNull();
    expect(thumb).toHaveClass("gone");
    expect(screen.getByText("thumbnail only")).toBeInTheDocument();
  });

  // ---- §2 embedding gate (mockup-proposals §02) ----

  it("explains an embedding model instead of offering a composer", async () => {
    seedSession({ model: "nomic-embed-text:latest" });
    await openSeeded(
      new FakeClient({
        models: [
          makeModel({
            tag: "nomic-embed-text:latest",
            isLoaded: true,
            capabilities: ["embedding"],
          }),
        ],
      }),
    );

    expect(screen.getByText("nomic-embed-text:latest is an embedding model.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });

  it("a model reporting no capabilities still gets a plain working composer", async () => {
    seedSession();
    const client = new FakeClient({ models: capableModels([]) });
    await openSeeded(client);

    // Absence of evidence is not evidence of absence (SPEC §9 version skew).
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Think" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach an image" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Still works" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await act(async () => {});
    expect(client.chatCalls).toHaveLength(1);
    expect(client.chatCalls[0].think).toBeUndefined();
    expect(client.chatCalls[0].options).toBeUndefined();
  });
  // ---- regressions from the pre-merge review ----

  it("times the reasoning, not the whole reply — the clock stops at the first content token", async () => {
    const client = new FakeClient({ models: capableModels(["completion", "thinking"]) });
    await startChatAndSend(client, "Which sort?");

    await act(async () => {
      client.emitChat({ content: "", thinking: "Mostly-sorted is the word.", done: false });
    });
    expect(screen.getByRole("button", { name: /^Thinking…/ })).toBeInTheDocument();

    // Content starts while the reply is STILL streaming. Ollama sends all
    // reasoning before any content, so thinking has ended here even though
    // the stream has not — the header must settle now rather than keep
    // counting the answer's duration into "Thought for …".
    await act(async () => {
      client.emitChat({ content: "Tim", done: false });
    });
    expect(screen.queryByRole("button", { name: /^Thinking…/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Thought for / })).toBeInTheDocument();

    await act(async () => {
      client.emitChat({ content: "sort.", done: true });
    });
    expect(screen.getByRole("button", { name: /^Thought for / })).toBeInTheDocument();
  });

  it("sends an image with no text — a picture is a message on its own", async () => {
    const client = new FakeClient({ models: capableModels(["completion", "vision"]) });
    renderChat(client);
    await untilLoaded();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    const file = new File(["tiny-png-bytes"], "shot.png", { type: "image/png" });
    await act(async () => {
      fireEvent.change(screen.getByTestId("attach-input"), { target: { files: [file] } });
    });
    await screen.findByLabelText("Attached images");

    // Composer left empty on purpose: this used to be a silent no-op with
    // the Send button still enabled.
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {});

    await waitFor(() => expect(client.chatCalls).toHaveLength(1));
    const outbound = client.chatCalls[0].messages;
    const sent = outbound[outbound.length - 1];
    expect(sent?.role).toBe("user");
    expect(sent?.images).toHaveLength(1);
    expect(sent?.images?.[0]).not.toContain("data:");
  });

  it("keys the num_ctx reload warning to the running context, not the model's maximum", async () => {
    seedSession();
    // Trained ceiling 8192, but the runner was started at 4096 — so 4096 is
    // the number that decides whether the next message reloads anything.
    const client = new FakeClient({
      models: capableModels(["completion"]),
      running: [
        {
          tag: "mistral:7b",
          sizeBytes: 4_700_000_000,
          sizeVramBytes: 4_700_000_000,
          contextLength: 4096,
          expiresAt: null,
        },
      ],
    });
    await openSeeded(client);

    fireEvent.click(screen.getByRole("button", { name: "Run controls" }));

    // Overridden to exactly what the runner is already using: nothing
    // reloads, so nothing should warn. Comparing against the 8192 ceiling
    // instead — as this did before — cried wolf here.
    fireEvent.change(screen.getByLabelText("Context length"), { target: { value: "4096" } });
    await act(async () => {});
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/reloads the model/)).not.toBeInTheDocument();

    // Genuinely different from the runner: this one does reload.
    fireEvent.change(screen.getByLabelText("Context length"), { target: { value: "6144" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Context length reloads the model.");
  });

  it("Bake into Modelfile opens the Modelfile with the overrides written in", async () => {
    const client = new FakeClient({
      models: capableModels(["completion"]),
      modelfile: 'FROM mistral:7b\n\nSYSTEM """Be helpful."""\n',
    });
    seedSession();
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Sidebar />
        <ChatView />
        <EditorView />
      </RemudaProvider>,
    );
    await untilLoaded();
    fireEvent.click(screen.getByText("Explain this regex"));

    fireEvent.click(screen.getByRole("button", { name: "Run controls" }));
    fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "0.9" } });
    fireEvent.click(screen.getByRole("button", { name: "Bake into Modelfile…" }));

    // openEditor awaits /api/show before a draft exists.
    await act(async () => {});
    // The whole point: the value has to arrive in the Modelfile. Navigating
    // to the editor without it — which is what this used to do — leaves a
    // chat-only user on an empty placeholder with the override discarded.
    await screen.findByLabelText("Raw Modelfile");
    await waitFor(() => {
      const raw = screen.getByLabelText("Raw Modelfile") as HTMLTextAreaElement;
      expect(raw.value).toContain("PARAMETER temperature 0.9");
    });
    // …and the passthrough content the editor promises to preserve survives.
    const raw = screen.getByLabelText("Raw Modelfile") as HTMLTextAreaElement;
    expect(raw.value).toContain("Be helpful.");
  });

});
