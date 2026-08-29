import "../chat/test/localStorage";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { ToolsView } from "./ToolsView";
import { parseTools, starterToolSets } from "./toolsets";
import { ViewTabs } from "../editor/ViewTabs";
import { RemudaProvider } from "../ui/state";
import { FakeClient, makeModel } from "../ui/test/FakeClient";
import type {
  ChatChunk,
  ChatMessage,
  KeepAlive,
  RunOptions,
  ThinkLevel,
} from "../api/types";

/**
 * FakeClient records chat() calls but not the `tools` array — that field
 * belongs to another agent's file. Recording it here keeps the assertion
 * ("what the user authored is what reached the request body") in this suite.
 */
class RecordingClient extends FakeClient {
  toolRequests: { messages: ChatMessage[]; tools?: unknown[] }[] = [];

  async *chat(
    tag: string,
    messages: ChatMessage[],
    opts: {
      keepAlive: KeepAlive;
      signal?: AbortSignal;
      think?: ThinkLevel;
      options?: RunOptions;
      tools?: unknown[];
    },
  ): AsyncIterable<ChatChunk> {
    this.toolRequests.push({ messages: messages.map((m) => ({ ...m })), tools: opts.tools });
    yield* super.chat(tag, messages, opts);
  }
}

function client(capabilities: string[], chatChunks?: ChatChunk[]): RecordingClient {
  return new RecordingClient({
    models: [makeModel({ tag: "qwen2.5:7b", isLoaded: true, capabilities })],
    chatChunks,
  });
}

function callChunk(name: string, args: Record<string, unknown>, extra: ChatChunk[] = []): ChatChunk[] {
  return [{ content: "", done: false, toolCalls: [{ name, arguments: args }] }, ...extra, { content: "", done: true }];
}

function renderTabs(c: FakeClient) {
  return render(
    <RemudaProvider client={c} pollIntervalMs={1_000_000}>
      <ViewTabs />
    </RemudaProvider>,
  );
}

function renderApp(c: FakeClient) {
  return render(<App client={c} />);
}

function renderPane(c: FakeClient) {
  return render(
    <RemudaProvider client={c} pollIntervalMs={1_000_000}>
      <ToolsView />
    </RemudaProvider>,
  );
}

/** The model list has landed once the Modelfile tab has something to open. */
async function untilModelLoaded() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Modelfile" })).toBeEnabled());
}

/** The card for one call. Addressed by its group label — the function name
 * appears in the header, in the respond box and in the schema editor. */
function toolCard(name: string): Promise<HTMLElement> {
  return screen.findByRole("group", { name: `Tool call ${name}` });
}

/** Render the pane, wait for the model, and send one prompt. */
async function ask(c: FakeClient, text = "weather in Wellington?") {
  renderPane(c);
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("Tool prompt"), { target: { value: text } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await act(async () => {});
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("the Tools tab's capability gate (SPEC §8: positive evidence)", () => {
  it("is absent when the server reported no capabilities at all", async () => {
    renderTabs(client([]));
    await untilModelLoaded();
    expect(screen.queryByRole("button", { name: "Tools" })).not.toBeInTheDocument();
  });

  it("is absent when the model lists other capabilities but not tools", async () => {
    renderTabs(client(["completion", "thinking", "vision"]));
    await untilModelLoaded();
    expect(screen.queryByRole("button", { name: "Tools" })).not.toBeInTheDocument();
  });

  it("is present when the model positively lists tools", async () => {
    renderTabs(client(["completion", "tools"]));
    await untilModelLoaded();
    expect(await screen.findByRole("button", { name: "Tools" })).toBeInTheDocument();
  });

  it("opens the playground in the main panel when the tab is clicked", async () => {
    renderApp(client(["tools"]));
    fireEvent.click(await screen.findByRole("button", { name: "Tools" }));
    expect(screen.getByLabelText("Tool schema")).toBeInTheDocument();
    expect(screen.getByLabelText("Tool prompt")).toBeInTheDocument();
  });

  it("says why rather than rendering a playground when nothing tool-capable is loaded", async () => {
    renderPane(client([]));
    expect(await screen.findByText(/Load a model that reports/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Tool prompt")).not.toBeInTheDocument();
  });
});

describe("the tool-call card", () => {
  it("badges every supplied argument against the schema the user wrote", async () => {
    const c = client(
      ["tools"],
      callChunk("get_weather", { city: "Wellington", unit: "F", country: "NZ" }),
    );
    await ask(c);

    const card = await toolCard("get_weather");
    expect(within(card).getByText("matched")).toBeInTheDocument();
    expect(within(card).getByText("ok")).toBeInTheDocument();
    expect(within(card).getByText("not in enum [celsius, fahrenheit]")).toBeInTheDocument();
    expect(within(card).getByText("unknown key")).toBeInTheDocument();
    expect(within(card).getByText('"Wellington"', { exact: false })).toBeInTheDocument();
  });

  it("lists a required key the model omitted, separately from what it sent", async () => {
    const c = client(["tools"], callChunk("get_weather", { unit: "celsius" }));
    await ask(c);

    const card = await toolCard("get_weather");
    expect(within(card).getByText("missing · required")).toBeInTheDocument();
    expect(within(card).getByText('"city"')).toBeInTheDocument();
    expect(within(card).getByText("1 missing")).toBeInTheDocument();
  });

  it("badges a call naming a tool the schema doesn't declare as no such tool", async () => {
    const c = client(["tools"], callChunk("get_wether", { city: "Wellington" }));
    await ask(c);

    const card = await toolCard("get_wether");
    expect(within(card).getByText("no such tool")).toBeInTheDocument();
    // No schema matched, so no per-key verdict is claimed — but the
    // arguments the model sent are still on screen.
    expect(within(card).getByText('"city"')).toBeInTheDocument();
    expect(within(card).queryByText("ok")).not.toBeInTheDocument();
  });

  it("marks a fully valid call valid", async () => {
    const c = client(["tools"], callChunk("get_weather", { city: "Wellington", unit: "celsius" }));
    await ask(c);
    const card = await toolCard("get_weather");
    expect(within(card).getByText("valid")).toBeInTheDocument();
    expect(within(card).queryByText(/invalid/)).not.toBeInTheDocument();
  });
});

describe("the request body", () => {
  it("sends the authored tools array verbatim, and the prompt with it", async () => {
    const c = client(["tools"], callChunk("get_weather", { city: "Wellington" }));
    await ask(c, "weather in Wellington?");
    await waitFor(() => expect(c.toolRequests).toHaveLength(1));
    expect(c.toolRequests[0].tools).toEqual(parseTools(starterToolSets()[0].text).tools);
    expect(c.toolRequests[0].messages).toEqual([{ role: "user", content: "weather in Wellington?" }]);
  });

  it("sends what the user edited, not what shipped", async () => {
    const c = client(["tools"], callChunk("ping", {}));
    renderPane(c);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());
    const authored = '[{"type":"function","function":{"name":"ping","parameters":{"type":"object","properties":{}}}}]';
    fireEvent.change(screen.getByLabelText("Tool schema"), { target: { value: authored } });
    fireEvent.change(screen.getByLabelText("Tool prompt"), { target: { value: "ping" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {});

    await waitFor(() => expect(c.toolRequests).toHaveLength(1));
    expect(c.toolRequests[0].tools).toEqual(JSON.parse(authored));
    // …and the call is judged against it: `ping` exists here and nowhere else.
    expect(await screen.findByText("matched")).toBeInTheDocument();
  });
});

describe("responding as a tool", () => {
  it("appends a role: tool message and continues the run", async () => {
    const c = client(["tools"]);
    renderPane(c);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Tool prompt"), { target: { value: "weather?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {
      c.emitChat({
        content: "",
        done: false,
        toolCalls: [{ name: "get_weather", arguments: { city: "Wellington" } }],
      });
      c.emitChat({ content: "", done: true });
    });

    await toolCard("get_weather");
    fireEvent.change(screen.getByLabelText("Respond as get_weather"), {
      target: { value: '{"temp_c": 13}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send result as get_weather" }));
    await act(async () => {});

    await waitFor(() => expect(c.toolRequests).toHaveLength(2));
    const second = c.toolRequests[1].messages;
    // tool_name rides along: newer Ollama uses it to match the result to the
    // call, and older servers ignore unknown keys.
    expect(second[second.length - 1]).toEqual({
      role: "tool",
      content: '{"temp_c": 13}',
      toolName: "get_weather",
    });
    // The run continues: the next reply streams into the same transcript.
    await act(async () => {
      c.emitChat({ content: "It's 13°C.", done: true });
    });
    expect(await screen.findByText("It's 13°C.")).toBeInTheDocument();
    expect(screen.getByText("responded as get_weather")).toBeInTheDocument();
  });
});

describe("a prose reply", () => {
  it("is recorded as a finding, not an error", async () => {
    const c = client(["tools"], [{ content: "It's about 13°C in Wellington.", done: true }]);
    await ask(c);
    expect(await screen.findByText("answered without calling a tool")).toBeInTheDocument();
    expect(screen.getByText("It's about 13°C in Wellington.")).toBeInTheDocument();
    // A prose reply is not a call, so it moves none of the counters.
    expect(screen.getByText("0 calls")).toBeInTheDocument();
    expect(screen.getByText("0 malformed")).toBeInTheDocument();
  });
});

describe("the session tally", () => {
  it("counts calls, valid and malformed — and Reset clears it", async () => {
    const c = client(["tools"], [
      {
        content: "",
        done: false,
        toolCalls: [
          { name: "get_weather", arguments: { city: "Wellington" } },
          { name: "get_weather", arguments: { city: "Wellington", unit: "F" } },
        ],
      },
      { content: "", done: true },
    ]);
    await ask(c);

    expect(await screen.findByText("2 calls")).toBeInTheDocument();
    expect(screen.getByText("1 valid")).toBeInTheDocument();
    expect(screen.getByText("1 malformed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText("0 calls")).toBeInTheDocument();
    expect(screen.getByText("0 valid")).toBeInTheDocument();
  });

  it("re-judges the calls already on screen when the schema changes", async () => {
    const c = client(["tools"], callChunk("get_weather", { city: "Wellington", unit: "F" }));
    await ask(c);
    expect(await screen.findByText("not in enum [celsius, fahrenheit]")).toBeInTheDocument();
    expect(screen.getByText("1 malformed")).toBeInTheDocument();

    const widened = starterToolSets()[0].text.replace('"fahrenheit"', '"fahrenheit",\n              "F"');
    fireEvent.change(screen.getByLabelText("Tool schema"), { target: { value: widened } });

    expect(screen.queryByText(/not in enum/)).not.toBeInTheDocument();
    expect(screen.getByText("1 valid")).toBeInTheDocument();
  });
});

describe("the schema editor", () => {
  it("shows a parse error and keeps every character the user typed", async () => {
    const c = client(["tools"]);
    renderPane(c);
    const box = await screen.findByLabelText("Tool schema");
    fireEvent.change(box, { target: { value: '[{"name": ' } });

    expect(screen.getByText(/Doesn't parse/)).toBeInTheDocument();
    expect(box).toHaveValue('[{"name": ');
    // And nothing is sent against a schema that doesn't parse.
    fireEvent.change(screen.getByLabelText("Tool prompt"), { target: { value: "weather?" } });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(c.toolRequests).toHaveLength(0);
  });

  it("persists the edit under the versioned key", async () => {
    const c = client(["tools"]);
    const { unmount } = renderPane(c);
    fireEvent.change(await screen.findByLabelText("Tool schema"), { target: { value: "[]" } });
    unmount();

    renderPane(client(["tools"]));
    expect(await screen.findByLabelText("Tool schema")).toHaveValue("[]");
  });
});

describe("layer 2 — pane help (R5)", () => {
  it("renders the toggle and shows the strip open on first sight", async () => {
    renderPane(client(["tools"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());

    const toggle = screen.getByRole("button", { name: "About the tool playground" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("region", { name: "About Tools — see what the model actually calls" }),
    ).toBeInTheDocument();
  });

  it("dismissing the strip persists the close", async () => {
    renderPane(client(["tools"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^Close help for Tools/ }));
    expect(
      screen.queryByRole("region", { name: "About Tools — see what the model actually calls" }),
    ).not.toBeInTheDocument();
    expect(window.localStorage.getItem("remuda.help.v1")).toContain("tools");
  });
});

describe("layer 1 — the empty state (R5)", () => {
  it("explains itself before any call has been made", async () => {
    renderPane(client(["tools"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());

    expect(
      screen.getByText("See exactly what the model calls, and whether it got it right"),
    ).toBeInTheDocument();
  });

  it("goes away once a call is on the transcript", async () => {
    const c = client(["tools"], callChunk("get_weather", { city: "Wellington" }));
    await ask(c);

    expect(
      screen.queryByText("See exactly what the model calls, and whether it got it right"),
    ).not.toBeInTheDocument();
  });
});
