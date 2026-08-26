import "./test/localStorage";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import { SESSIONS_STORAGE_KEY, type ChatSession } from "./sessions";
import { Sidebar } from "../ui/Sidebar";
import { RemudaProvider } from "../ui/state";
import { FakeClient, makeModel } from "../ui/test/FakeClient";

function fixtureModels() {
  return [
    makeModel({ tag: "llama3.1:8b", isLoaded: true }),
    makeModel({ tag: "mistral:7b" }),
  ];
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
    // The session persisted, bound to the loaded variant (SPEC §5.2, §6).
    const stored = JSON.parse(window.localStorage.getItem(SESSIONS_STORAGE_KEY) ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].model).toBe("llama3.1:8b");
    expect(stored[0].title).toBe("New chat");
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
    // 90 tokens / 2s = 45 tok/s, shown once the reply completes.
    expect(await screen.findByText("45 tok/s")).toBeInTheDocument();
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
      "mistral:7b isn’t loaded — currently loaded: llama3.1:8b. Load it to continue this chat.",
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
    expect(screen.getByRole("status")).toHaveTextContent("currently loaded: nothing");
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
});
