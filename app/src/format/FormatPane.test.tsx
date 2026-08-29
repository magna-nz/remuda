import "../chat/test/localStorage";
import { untilModelResident } from "../ui/test/newMenu";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ChatView } from "../chat/ChatView";
import { SESSIONS_STORAGE_KEY, type ChatSession, type FormatConfig } from "../chat/sessions";
import { Sidebar } from "../ui/Sidebar";
import { RemudaProvider } from "../ui/state";
import { FakeClient, makeModel } from "../ui/test/FakeClient";
import { STARTER_SCHEMA } from "./format";
import type {
  ChatChunk,
  ChatFormat,
  ChatMessage,
  KeepAlive,
  RunOptions,
  ThinkLevel,
} from "../api/types";

/**
 * FakeClient records chat() calls but not `format` — it is shared with every
 * other suite, so the field this feature added is recorded here instead, and
 * the assertion that matters ("what the pane holds is what reached the
 * request") stays in this file.
 */
class RecordingClient extends FakeClient {
  formats: (ChatFormat | undefined)[] = [];
  /** Every call, so "no format key at all" is distinguishable from "no call". */
  sends = 0;

  async *chat(
    tag: string,
    messages: ChatMessage[],
    opts: {
      keepAlive: KeepAlive;
      signal?: AbortSignal;
      think?: ThinkLevel;
      options?: RunOptions;
      tools?: unknown[];
      format?: ChatFormat;
    },
  ): AsyncIterable<ChatChunk> {
    this.sends += 1;
    this.formats.push(opts.format);
    yield* super.chat(tag, messages, opts);
  }
}

const SCHEMA_OBJECT = {
  type: "object",
  properties: {
    summary: { type: "string" },
    breaking: { type: "boolean" },
    issues: { type: "array", items: { type: "integer" } },
    severity: { type: "string", enum: ["patch", "minor", "major"] },
  },
  required: ["summary", "severity"],
};

function seedSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const session: ChatSession = {
    id: "s-seeded",
    title: "Extracting release notes",
    model: "mistral:7b",
    messages: [
      { role: "user", content: "Summarise the diff" },
      { role: "assistant", content: "It renames the paste chord." },
    ],
    updatedAt: "2026-08-26T10:00:00.000Z",
    ...overrides,
  };
  window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify([session]));
  return session;
}

function client(chatChunks?: ChatChunk[]): RecordingClient {
  return new RecordingClient({
    models: [makeModel({ tag: "mistral:7b", isLoaded: true, capabilities: ["completion"] })],
    chatChunks,
  });
}

async function openSeeded(c: FakeClient) {
  render(
    <RemudaProvider client={c} pollIntervalMs={1_000_000}>
      <Sidebar />
      <main>
        <ChatView />
      </main>
    </RemudaProvider>,
  );
  await untilModelResident();
  fireEvent.click(screen.getByText("Extracting release notes"));
}

function pill(mode: string) {
  return screen.getByRole("button", { name: `Format · ${mode}` });
}

/** Type a message and press Enter, the way the composer sends. */
async function send(text = "Summarise the next one") {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
  await act(async () => {});
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("the pane and its pill", () => {
  it("opens off, and opens the pane on the starter schema", async () => {
    seedSession();
    await openSeeded(client());

    expect(pill("off")).not.toHaveClass("dirty");
    fireEvent.click(pill("off"));

    const pane = screen.getByRole("region", { name: "Format" });
    expect(within(pane).getByLabelText("Response schema")).toHaveValue(STARTER_SCHEMA);
    expect(within(pane).getByText(/valid schema · 4 properties/)).toBeInTheDocument();
    // No Modelfile affordance anywhere: there is no PARAMETER format.
    expect(within(pane).queryByText(/Modelfile/i)).toBeNull();
    expect(within(pane).getByText("this chat only")).toBeInTheDocument();
  });

  it("marks the pill once a constraint is in force", async () => {
    seedSession({ format: { mode: "schema", text: STARTER_SCHEMA } });
    await openSeeded(client());
    expect(pill("schema")).toHaveClass("dirty");
  });

  it("keeps the raw text across a mode switch, and persists it half-typed", async () => {
    seedSession();
    await openSeeded(client());
    fireEvent.click(pill("off"));

    const half = '{ "type": "object", "properties": { "summary": { "type": "str';
    fireEvent.change(screen.getByLabelText("Response schema"), { target: { value: half } });
    // Switching away must not discard what is in the editor — a schema you
    // switched off is one you are coming back to.
    fireEvent.click(screen.getByRole("button", { name: "json" }));
    expect(screen.getByLabelText("Response schema")).toHaveValue(half);

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(SESSIONS_STORAGE_KEY) ?? "[]");
      expect(stored[0].format).toEqual({ mode: "json", text: half });
    });
  });
});

describe("layer 2 — pane help (R5)", () => {
  it("renders the toggle and shows the strip open on first sight", async () => {
    seedSession();
    await openSeeded(client());
    fireEvent.click(pill("off"));

    const pane = screen.getByRole("region", { name: "Format" });
    const toggle = within(pane).getByRole("button", { name: "About Format" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      within(pane).getByRole("region", { name: "About Format. Force the reply into a shape" }),
    ).toBeInTheDocument();
  });

  it("dismissing the strip persists the close", async () => {
    seedSession();
    await openSeeded(client());
    fireEvent.click(pill("off"));

    fireEvent.click(screen.getByRole("button", { name: /^Close help for Format/ }));
    expect(
      screen.queryByRole("region", { name: "About Format. Force the reply into a shape" }),
    ).not.toBeInTheDocument();
    expect(window.localStorage.getItem("remuda.help.v1")).toContain("format");
  });
});

describe("layer 1 — the empty state (R5)", () => {
  it("explains itself while off, and steps back once a constraint is chosen", async () => {
    seedSession();
    await openSeeded(client());
    fireEvent.click(pill("off"));

    const pane = screen.getByRole("region", { name: "Format" });
    expect(within(pane).getByText("Nothing is constrained yet")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    expect(within(pane).queryByText("Nothing is constrained yet")).not.toBeInTheDocument();
  });
});

describe("what reaches the request", () => {
  it("omits `format` entirely while off", async () => {
    seedSession();
    const c = client([{ content: "{}", done: true }]);
    await openSeeded(c);
    await send();
    expect(c.sends).toBe(1);
    expect(c.formats[0]).toBeUndefined();
  });

  it("sends the literal string in json mode", async () => {
    seedSession({ format: { mode: "json", text: STARTER_SCHEMA } });
    const c = client([{ content: "{}", done: true }]);
    await openSeeded(c);
    await send();
    expect(c.formats[0]).toBe("json");
  });

  it("sends the parsed schema object in schema mode", async () => {
    seedSession({ format: { mode: "schema", text: STARTER_SCHEMA } });
    const c = client([{ content: "{}", done: true }]);
    await openSeeded(c);
    await send();
    expect(c.formats[0]).toEqual(SCHEMA_OBJECT);
  });

  it("sends what the user just typed, not what was stored", async () => {
    seedSession({ format: { mode: "schema", text: STARTER_SCHEMA } });
    const c = client([{ content: "{}", done: true }]);
    await openSeeded(c);
    fireEvent.click(pill("schema"));
    fireEvent.change(screen.getByLabelText("Response schema"), {
      target: { value: '{"type":"object","properties":{"ok":{"type":"boolean"}}}' },
    });
    await send();
    expect(c.formats[0]).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
  });
});

describe("a schema that doesn't parse refuses the send", () => {
  const BROKEN: FormatConfig = { mode: "schema", text: '{"type": "obj' };

  it("disables Send and says why", async () => {
    seedSession({ format: BROKEN });
    await openSeeded(client());
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go" } });
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringContaining("doesn’t parse"));
  });

  it("sends nothing on Enter, and opens the pane on the local error", async () => {
    seedSession({ format: BROKEN });
    const c = client([{ content: "{}", done: true }]);
    await openSeeded(c);
    await send("go");

    // Nothing was sent — an unconstrained reply here would read as the model
    // ignoring a shape it was never given.
    expect(c.sends).toBe(0);
    const pane = screen.getByRole("region", { name: "Format" });
    expect(within(pane).getByText(/Doesn’t parse/)).toBeInTheDocument();
    // And the draft the user typed is still there to send once it's fixed.
    expect(screen.getByLabelText("Message")).toHaveValue("go");
  });

  it("refuses a regenerate too, with the reason in the log", async () => {
    // The store's own guard, reached from a path that never touches the
    // composer: a re-roll under a broken schema would come back
    // unconstrained and look like the model changing its mind.
    seedSession({
      format: BROKEN,
      messages: [
        { id: "m-1", role: "user", content: "Summarise the diff" },
        { id: "m-2", role: "assistant", content: '{"summary":"s","severity":"patch"}' },
      ],
    });
    const c = client([{ content: "{}", done: true }]);
    await openSeeded(c);

    fireEvent.click(screen.getByRole("button", { name: "Reply actions for message 2" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Regenerate · new seed/ }));
    await act(async () => {});

    expect(c.sends).toBe(0);
    expect(await screen.findByRole("alert")).toHaveTextContent(/doesn’t parse/);
  });
});

describe("the conformance card", () => {
  /**
   * `constrained: true` is what a reply generated under a schema carries
   * (R2). It is set here explicitly because that is what these tests are
   * about — see "leaves an older, unconstrained reply alone" below for the
   * other half.
   */
  function seedReply(content: string, format: FormatConfig, options?: RunOptions) {
    seedSession({
      format,
      options,
      messages: [
        { id: "m-1", role: "user", content: "Summarise the diff" },
        { id: "m-2", role: "assistant", content, constrained: true },
      ],
    });
  }

  const SCHEMA: FormatConfig = { mode: "schema", text: STARTER_SCHEMA };

  /**
   * Switching a schema on must not retroactively judge the conversation
   * behind it. A reply written as prose was never asked to be JSON, so a red
   * "not valid JSON" verdict under it is a false alarm about a model that
   * did nothing wrong.
   */
  it("leaves an older, unconstrained reply alone when a schema is switched on", async () => {
    seedSession({
      format: { mode: "schema", text: STARTER_SCHEMA },
      messages: [
        { id: "m-1", role: "user", content: "Summarise the diff" },
        { id: "m-2", role: "assistant", content: "It renames the paste chord." },
      ],
    });
    await openSeeded(client());

    expect(screen.queryByRole("group", { name: "Conformance" })).not.toBeInTheDocument();
  });

  it("badges every property of a reply that fits", async () => {
    seedReply(
      JSON.stringify({ summary: "s", breaking: false, issues: [43, 45], severity: "patch" }),
      SCHEMA,
    );
    await openSeeded(client());

    const card = await screen.findByRole("group", { name: "Conformance" });
    expect(within(card).getByText("Conforms")).toBeInTheDocument();
    expect(within(card).getByText("4 of 4 properties · 2 of 2 required present")).toBeInTheDocument();
    expect(within(card).getByText("integer[]")).toBeInTheDocument();
    expect(within(card).getByText("enum")).toBeInTheDocument();
  });

  it("names the property that failed and what was expected", async () => {
    seedReply(JSON.stringify({ summary: 7, severity: "patch" }), SCHEMA);
    await openSeeded(client());

    const card = await screen.findByRole("group", { name: "Conformance" });
    expect(within(card).getByText("Doesn’t conform")).toBeInTheDocument();
    expect(
      within(card).getByText("wrong type · expected string, got integer"),
    ).toBeInTheDocument();
  });

  it("reports a cut-off reply as cut off, naming num_predict", async () => {
    // The most common way constrained output fails: `format` makes invalid
    // JSON unreachable, so a reply that doesn't parse ran out of tokens.
    seedReply('{"summary":"Refactor the Linux bundle path so the App', SCHEMA, {
      numPredict: 64,
    });
    await openSeeded(client());

    const card = await screen.findByRole("group", { name: "Conformance" });
    expect(within(card).getByText("Cut off, not valid JSON")).toBeInTheDocument();
    expect(within(card).getByText("num_predict 64 reached")).toBeInTheDocument();
    expect(within(card).getByText("truncated mid-string")).toBeInTheDocument();
    // breaking, issues and severity all stopped short of being written.
    expect(within(card).getAllByText("never emitted")).toHaveLength(3);
    // Not a parse error, in any of its forms.
    expect(within(card).queryByText(/Unexpected end of JSON/i)).toBeNull();
    expect(within(card).queryByText("Not valid JSON")).toBeNull();
  });

  it("re-judges a reply already on screen when the schema changes", async () => {
    seedReply(JSON.stringify({ summary: "s" }), SCHEMA);
    await openSeeded(client());
    expect(
      within(await screen.findByRole("group", { name: "Conformance" })).getByText(
        "Doesn’t conform",
      ),
    ).toBeInTheDocument();

    fireEvent.click(pill("schema"));
    fireEvent.change(screen.getByLabelText("Response schema"), {
      target: { value: '{"type":"object","properties":{"summary":{"type":"string"}}}' },
    });

    await waitFor(() =>
      expect(
        within(screen.getByRole("group", { name: "Conformance" })).getByText("Conforms"),
      ).toBeInTheDocument(),
    );
  });

  it("shows nothing while the constraint is off", async () => {
    seedReply(JSON.stringify({ summary: "s" }), { mode: "off", text: STARTER_SCHEMA });
    await openSeeded(client());
    await screen.findByText(/"summary"/);
    expect(screen.queryByRole("group", { name: "Conformance" })).toBeNull();
  });

  it("waits for the reply to finish before calling anything cut off", async () => {
    // Mid-stream every reply is a prefix of an object, which is exactly what
    // truncation looks like. A card that judged as it streamed would say
    // "cut off" about every reply right up until it wasn't.
    // No earlier reply in the transcript: this test is about the one that
    // is streaming, and every finished reply gets a card of its own.
    seedSession({ format: SCHEMA, messages: [{ id: "m-1", role: "user", content: "Go" }] });
    const c = client();
    await openSeeded(c);
    await send();
    c.emitChat({ content: '{"summary":"half', done: false });
    await act(async () => {});
    expect(screen.queryByRole("group", { name: "Conformance" })).toBeNull();

    c.emitChat({ content: ' a summary","severity":"patch"}', done: true });
    await act(async () => {});
    expect(
      within(await screen.findByRole("group", { name: "Conformance" })).getByText("Conforms"),
    ).toBeInTheDocument();
  });
});

/**
 * Found by opening the menu in the packaged app: it appeared as a sliver with
 * its labels cut in half. An assistant row anchors its button at the far left
 * of the message column, so the default right-anchored dropdown grew leftward
 * out of the transcript's scroll container, which clips it. Pre-existing — no
 * round-two change touched ReplyMenu.css or .msgfoot — but reachable from
 * every reply on screen.
 */
describe("the assistant reply menu opens into the pane, not out of it", () => {
  it("pins the dropdown to the left edge", async () => {
    seedSession({
      messages: [
        { id: "m-1", role: "user", content: "Summarise the diff" },
        { id: "m-2", role: "assistant", content: "It renames the paste chord." },
      ],
    });
    await openSeeded(client());

    fireEvent.click(screen.getByRole("button", { name: "Reply actions for message 2" }));

    const menu = screen.getByRole("menu", { name: /Reply actions for message 2/ });
    expect(menu.className).toContain("left");
  });
});
