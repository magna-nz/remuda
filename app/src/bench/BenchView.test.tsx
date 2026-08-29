import "../chat/test/localStorage";
/**
 * Bench, on screen (docs/SPEC-tuning.md T5, docs/SPEC-round-two.md R4):
 * the rail group, capture off a message menu, the run table, and the empty
 * state that answers "what *is* a bench".
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BenchView } from "./BenchView";
import { BENCH_STORAGE_KEY, type Bench } from "./benches";
import { ReplyMenu } from "../chat/ReplyMenu";
import { RemudaProvider, useRemuda } from "../ui/state";
import { Sidebar } from "../ui/Sidebar";
import App from "../App";
import { FakeClient, makeModel } from "../ui/test/FakeClient";
import type { ChatChunk, ChatMessage, KeepAlive, RunOptions, ThinkLevel } from "../api/types";

const MODEL = "terse-v2:latest";

/**
 * A FakeClient that answers each chat() call from its own script, and
 * records the seed each call carried. FakeClient's own `chatChunks` is one
 * script for every call, which cannot express "prompt 2 failed".
 */
class ScriptedClient extends FakeClient {
  script: (string | Error)[] = [];
  seeds: (number | undefined)[] = [];
  prompts: string[] = [];
  /** Resolves when the test lets the next answer through; null = no gate. */
  gate: (() => Promise<void>) | null = null;

  override async *chat(
    tag: string,
    messages: ChatMessage[],
    opts: {
      keepAlive: KeepAlive;
      signal?: AbortSignal;
      think?: ThinkLevel;
      options?: RunOptions;
    },
  ): AsyncIterable<ChatChunk> {
    const index = this.seeds.length;
    this.seeds.push(opts.options?.seed);
    this.prompts.push(messages[messages.length - 1]?.content ?? "");
    void tag;
    if (this.gate !== null) await this.gate();
    if (opts.signal?.aborted === true) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const entry = this.script[index];
    if (entry instanceof Error) throw entry;
    yield { content: entry ?? "", done: false };
    yield { content: "", done: true, stats: { evalCount: 12, evalDurationNs: 1_000_000_000 } };
  }
}

function seedBench(overrides: Partial<Bench> = {}): Bench {
  const bench: Bench = {
    id: "b-1",
    name: "Coding voice",
    model: MODEL,
    prompts: [],
    runs: [],
    ...overrides,
  };
  window.localStorage.setItem(BENCH_STORAGE_KEY, JSON.stringify([bench]));
  return bench;
}

function models() {
  return [makeModel({ tag: MODEL, isLoaded: true })];
}

function renderBench(client: FakeClient, extra?: React.ReactNode) {
  return render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <Sidebar />
      <main>
        <BenchView />
        {extra}
      </main>
    </RemudaProvider>,
  );
}

async function untilLoaded() {
  await waitFor(() => expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled());
}

/** Open the seeded bench from the rail. */
async function openSeeded(client: FakeClient, extra?: React.ReactNode) {
  renderBench(client, extra);
  await untilLoaded();
  fireEvent.click(screen.getByText("Coding voice"));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("the Benches rail group", () => {
  it("sits above Recent and names itself even when empty", async () => {
    renderBench(new FakeClient({ models: models() }));
    await untilLoaded();
    const labels = Array.from(document.querySelectorAll(".side-label")).map((el) =>
      el.textContent?.replace("+", ""),
    );
    expect(labels).toEqual(["Benches", "Recent"]);
    // The word has to be encounterable somewhere before a bench exists.
    expect(screen.getByText(/A bench is a set of prompts you re-run/i)).toBeInTheDocument();
  });

  it("lists a bench with its prompt and run counts", async () => {
    seedBench({
      prompts: [{ id: "p1", text: "one" }, { id: "p2", text: "two" }],
      runs: [{ id: "r1", ranAt: "2026-08-01T10:00:00Z", snapshotId: null, seed: 1, partial: false, results: [] }],
    });
    renderBench(new FakeClient({ models: models() }));
    await untilLoaded();
    expect(screen.getByText("2 prompts · 1 run")).toBeInTheDocument();
  });

  it("+ New bench makes one and opens it on the explainer", async () => {
    renderBench(new FakeClient({ models: models() }));
    await untilLoaded();
    fireEvent.click(screen.getByRole("button", { name: "New bench" }));
    expect(await screen.findByText("A bench is a set of prompts you re-run after a change")).toBeInTheDocument();
    expect(screen.getByText(/never scores them/i)).toBeInTheDocument();
  });
});

describe("the empty state", () => {
  it("says what a bench is, why, and the three steps to fill it", async () => {
    seedBench();
    await openSeeded(new FakeClient({ models: models() }));
    expect(screen.getByText("A bench is a set of prompts you re-run after a change")).toBeInTheDocument();
    expect(screen.getByText(/which answers moved/i)).toBeInTheDocument();
    // Scoped to the empty state: the pane's `?` explainer also lists three
    // steps, and it is open by default the first time a pane is seen.
    const empty = document.querySelector(".emptyfeat");
    expect(empty).not.toBeNull();
    const steps = within(empty as HTMLElement).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]!.textContent).toContain("Add to bench");
    expect(steps[1]!.textContent).toContain("Run all");
    expect(steps[2]!.textContent).toContain("Changed");
    // The rule the whole surface is built around.
    expect(screen.getByText("Remuda diffs the answers. It never scores them.")).toBeInTheDocument();
  });

  it("offers no Run all to press with nothing to run", async () => {
    seedBench();
    await openSeeded(new FakeClient({ models: models() }));
    expect(screen.getByRole("button", { name: "Run all" })).toBeDisabled();
  });
});

/** What ChatView's user-message menu will call — the whole capture chain. */
function CaptureHarness({ text }: { text: string }) {
  const { addToBench } = useRemuda();
  return (
    <ReplyMenu
      name="for message 1"
      label="Prompt actions"
      open
      onToggle={() => {}}
      onClose={() => {}}
      onAddToBench={() => addToBench(text, MODEL)}
    />
  );
}

describe("capture", () => {
  it("adds the prompt from the message menu, with no form in the way", async () => {
    seedBench();
    await openSeeded(
      new FakeClient({ models: models() }),
      <CaptureHarness text="Explain a mutex to someone who writes only Python." />,
    );
    // The prompt-side menu offers capture and nothing that only makes sense
    // about an answer.
    const menu = screen.getByRole("menu", { name: "Prompt actions for message 1" });
    expect(within(menu).getByRole("menuitem", { name: /Add to bench/ })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /Promote to SYSTEM/ })).toBeNull();

    fireEvent.click(within(menu).getByRole("menuitem", { name: /Add to bench/ }));

    expect(await screen.findByText("Explain a mutex to someone who writes only Python.")).toBeInTheDocument();
    expect(screen.getByText("1 prompt · never run")).toBeInTheDocument();
    // The explainer is gone: the bench is no longer empty.
    expect(screen.queryByText("A bench is a set of prompts you re-run after a change")).toBeNull();

    // The same prompt twice adds nothing.
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Add to bench/ }));
    await waitFor(() => expect(screen.getByText("1 prompt · never run")).toBeInTheDocument());
  });

  it("creates a bench for the model when there isn't one", async () => {
    renderBench(new FakeClient({ models: models() }), <CaptureHarness text="Be blunt about this SQL." />);
    await untilLoaded();
    fireEvent.click(screen.getByRole("menuitem", { name: /Add to bench/ }));
    expect(await screen.findByText("terse-v2 bench")).toBeInTheDocument();
    expect(screen.getByText("1 prompt · never run")).toBeInTheDocument();
  });

  it("survives having no prompt worth keeping", async () => {
    seedBench();
    await openSeeded(new FakeClient({ models: models() }), <CaptureHarness text="   " />);
    fireEvent.click(screen.getByRole("menuitem", { name: /Add to bench/ }));
    expect(screen.getByText("no prompts yet")).toBeInTheDocument();
  });
});

const THREE = [
  { id: "p1", text: "Rewrite this loop to bail early." },
  { id: "p2", text: "Explain a mutex to a Python programmer." },
  { id: "p3", text: "Summarise this stack trace." },
];

const FIRST_RUN = {
  id: "r1",
  ranAt: "2026-08-01T10:00:00.000Z",
  snapshotId: null,
  seed: 111,
  partial: false,
  results: [
    { promptId: "p1", content: "Use break once seen has the id, because the rest cannot matter." },
    { promptId: "p2", content: "A single key on a hook by the door." },
    { promptId: "p3", content: "It dereferenced a null body." },
  ],
};

describe("the run table", () => {
  it("badges changed, same and error, sorted changed-first, and tallies them", async () => {
    seedBench({ prompts: THREE, runs: [FIRST_RUN] });
    const client = new ScriptedClient({ models: models() });
    client.script = [
      "Use break once seen has the id — the rest of the scan cannot matter.",
      "A single key on a hook by the door.",
      new Error("context length exceeded — prompt is 34102 tokens, num_ctx is 26624"),
    ];
    await openSeeded(client);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    });

    await waitFor(() => expect(screen.getByText("1 changed")).toBeInTheDocument());
    expect(screen.getByText("1 same")).toBeInTheDocument();
    expect(screen.getByText("1 error")).toBeInTheDocument();

    // Scoped to the run table: the pane's `?` toggle is an aria-expanded
    // button too, and it sorts ahead of the rows in document order.
    const table = document.querySelector(".bench") as HTMLElement;
    const rows = within(table).getAllByRole("button", { expanded: false });
    expect(rows[0]!.textContent).toContain("Rewrite this loop to bail early.");
    expect(rows[0]!.textContent).toContain("Changed");
    // A failure is a row, kept with its cause — not a dropped result.
    expect(screen.getByText(/context length exceeded — prompt is 34102 tokens/)).toBeInTheDocument();
    // And it did not abort the sweep: all three prompts ran.
    expect(client.prompts).toHaveLength(3);
  });

  it("pins one seed across every prompt, and names it in the header", async () => {
    seedBench({ prompts: THREE, runs: [FIRST_RUN] });
    const client = new ScriptedClient({ models: models() });
    client.script = ["a", "b", "c"];
    await openSeeded(client);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    });
    await waitFor(() =>
      expect((document.querySelector(".runbar") as HTMLElement).textContent).toMatch(
        /seed \d+/,
      ),
    );
    expect(client.seeds).toHaveLength(3);
    expect(new Set(client.seeds).size).toBe(1);
    expect(client.seeds[0]).toEqual(expect.any(Number));
    // `seed` is a <Term> now, so the word and the number are separate nodes.
    expect((document.querySelector(".runbar") as HTMLElement).textContent).toContain(
      `seed ${String(client.seeds[0])}`,
    );
  });

  it("rows are collapsed until asked, and expand to the two answers word-diffed", async () => {
    seedBench({ prompts: THREE, runs: [FIRST_RUN] });
    const client = new ScriptedClient({ models: models() });
    client.script = [
      "Use break once seen has the id, because nothing else matters.",
      "A single key on a hook by the door.",
      "It dereferenced a null body.",
    ];
    await openSeeded(client);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    });
    await waitFor(() => expect(screen.getByText("1 changed")).toBeInTheDocument());

    // Collapsed by default: no answer column is on screen.
    expect(document.querySelector(".bcol")).toBeNull();
    // Scoped: the pane's `?` toggle is an aria-expanded button too.
    const table = document.querySelector(".bench") as HTMLElement;
    fireEvent.click(within(table).getAllByRole("button", { expanded: false })[0]!);

    const columns = document.querySelectorAll(".bcol");
    expect(columns).toHaveLength(2);
    // Reused from editor/diff.ts: the words that moved, and only those.
    // "because" is common to both answers, so it is not marked; only the
    // words that actually moved are.
    expect(document.querySelector(".bcol-b del")!.textContent).toContain("the rest cannot matter.");
    expect(document.querySelector(".bcol-b ins")!.textContent).toContain("nothing else matters.");
    expect(document.querySelector(".bcol-b del")!.textContent).not.toContain("because");
  });

  it("a bench that has never run shows its prompts as not run", async () => {
    seedBench({ prompts: THREE });
    await openSeeded(new FakeClient({ models: models() }));
    expect(screen.getAllByText("Not run")).toHaveLength(3);
    expect(screen.getByText(/Never run\./)).toBeInTheDocument();
  });
});

describe("cancelling a run", () => {
  it("keeps the finished rows and records the run partial", async () => {
    seedBench({ prompts: THREE, runs: [FIRST_RUN] });
    const client = new ScriptedClient({ models: models() });
    client.script = ["changed answer", "b", "c"];
    // Hold every answer until the test releases it, so cancel can land
    // between prompt 1 and prompt 2.
    let release: () => void = () => {};
    let held = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.gate = () => held;

    await openSeeded(client);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    });
    // Let prompt 1 through, then re-gate so prompt 2 waits.
    await act(async () => {
      const open = release;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      open();
    });
    await waitFor(() => expect(client.prompts.length).toBeGreaterThanOrEqual(2));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      release();
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Run all" })).toBeInTheDocument());

    const stored: Bench[] = JSON.parse(window.localStorage.getItem(BENCH_STORAGE_KEY)!);
    const newest = stored[0]!.runs[0]!;
    expect(newest.partial).toBe(true);
    // Its one finished row survived rather than being discarded.
    expect(newest.results).toHaveLength(1);
    expect(newest.results[0]!).toMatchObject({ promptId: "p1", content: "changed answer" });
    // Two runs on record now — the partial did not overwrite the first.
    expect(stored[0]!.runs).toHaveLength(2);
    // Said on the run bar, and again in the run picker.
    expect(screen.getAllByText(/partial/).length).toBeGreaterThan(0);
  });
});

describe("deleting a bench", () => {
  it("asks first, under the existing confirm toggle", async () => {
    seedBench({ prompts: THREE });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderBench(new FakeClient({ models: models() }));
    await untilLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Delete bench Coding voice" }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByText("Coding voice")).toBeInTheDocument();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete bench Coding voice" }));
    await waitFor(() => expect(screen.queryByText("Coding voice")).toBeNull());
    confirm.mockRestore();
  });
});

/**
 * The wiring the harness above stands in for.
 *
 * `CaptureHarness` proves the store chain; this proves the two joins that
 * make Bench reachable at all — a `bench` branch in `App`'s panel router,
 * and a menu on *user* messages in the real `ChatView`. Both were left
 * undone when Bench was built, and with either missing the feature is
 * complete and invisible.
 */
describe("Bench is reachable from the real app", () => {
  it("puts a capture menu on a user message and opens the bench from the rail", async () => {
    // A chat with one user message already in it.
    window.localStorage.setItem(
      "remuda.sessions.v1",
      JSON.stringify([
        {
          id: "s-1",
          title: "Tuning",
          model: MODEL,
          updatedAt: new Date().toISOString(),
          messages: [{ id: "m-1", role: "user", content: "Explain a mutex in one line." }],
        },
      ]),
    );
    render(<App client={new FakeClient({ models: models() })} />);
    await untilLoaded();
    // Nothing is open on launch; the rail is how you get into a chat.
    fireEvent.click(screen.getByText("Tuning"));

    // The prompt carries its own menu — capture, and nothing that only makes
    // sense about an answer.
    fireEvent.click(screen.getByRole("button", { name: /Prompt actions for prompt 1/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Add to bench/ }));

    // And the rail now leads somewhere: App routes view === "bench".
    fireEvent.click(await screen.findByText(/bench$/, { selector: ".stitle" }));
    expect(await screen.findByText("Explain a mutex in one line.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run all" })).toBeInTheDocument();
  });
});

/**
 * SPEC §8 is one generation at a time, app-wide, and the store enforces it by
 * silently refusing. A control left enabled through a refusal is a dead
 * button — the user presses Send and nothing happens at all, with the message
 * still sitting in the box and no explanation. A bench replay runs one chat
 * call per prompt, so that window is minutes wide, not milliseconds.
 */
describe("the one-generation-at-a-time guard is visible, not just enforced", () => {
  it("disables the chat composer while a bench replay is in flight", async () => {
    window.localStorage.setItem(
      "remuda.sessions.v1",
      JSON.stringify([
        {
          id: "s-1",
          title: "Tuning",
          model: MODEL,
          updatedAt: new Date().toISOString(),
          messages: [],
        },
      ]),
    );
    seedBench({ prompts: [{ id: "p-1", text: "Explain a mutex in one line." }] });
    // No emitChat(): the bench's first prompt hangs, holding the run open.
    render(<App client={new FakeClient({ models: models() })} />);
    await untilLoaded();

    fireEvent.click(screen.getByText("Coding voice"));
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument());

    // Now walk into the chat the way a user would, mid-replay.
    fireEvent.click(screen.getByText("Tuning"));
    expect(screen.getByRole("button", { name: /Send/ })).toBeDisabled();
  });
});
