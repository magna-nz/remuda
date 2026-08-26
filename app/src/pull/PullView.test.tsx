import "../chat/test/localStorage";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { PullView } from "./PullView";
import { RemudaProvider } from "../ui/state";
import { FakeClient, makeModel } from "../ui/test/FakeClient";

function renderPull(client: FakeClient) {
  return render(
    <RemudaProvider client={client} pollIntervalMs={1_000_000}>
      <PullView />
    </RemudaProvider>,
  );
}

/**
 * Wait for the first health check to populate the model list / connection.
 *
 * Anchored on a catalog row's Pull button rather than the input: the input is
 * never disabled (it searches a bundled file), so it makes a useless signal.
 * `mixtral` is a model no test installs, so its row always offers Pull.
 */
async function untilChecked() {
  await waitFor(() =>
    expect(within(catalogRow("mixtral")).getByRole("button", { name: "Pull" })).toBeEnabled(),
  );
}

/**
 * The pull bar's own "Pull" button, scoped away from the catalog rows
 * (which also have "Pull" buttons — an unscoped role query is ambiguous).
 */
function barPullButton(): HTMLElement {
  const input = screen.getByLabelText("Model to pull");
  const bar = input.closest(".pullbar") as HTMLElement;
  return within(bar).getByRole("button", { name: "Pull" });
}

function submitPull(tag: string) {
  fireEvent.change(screen.getByLabelText("Model to pull"), { target: { value: tag } });
  fireEvent.click(barPullButton());
}

/**
 * A catalog row by its model name — scoped to `.regrow .rt b`, since the
 * name also appears (as an example) in the note-strip's `<code>`.
 */
function catalogRow(name: string): HTMLElement {
  const heading = screen.getAllByText(name, { selector: ".regrow .rt b" })[0];
  return heading.closest(".regrow") as HTMLElement;
}

/** Type into the field without submitting — drives search and the probe. */
function typeQuery(text: string) {
  fireEvent.change(screen.getByLabelText("Model to pull"), { target: { value: text } });
}

/**
 * Stand in for the Tauri bridge that `withGlobalTauri` injects. Returns the
 * spy so a test can assert what the frontend actually asked for.
 */
function stubBridge(impl: (reference: string) => Promise<unknown>) {
  const invoke = vi.fn((_cmd: string, args?: Record<string, unknown>) =>
    impl(args?.reference as string),
  );
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
  return invoke;
}

beforeEach(() => {
  window.localStorage.clear();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

describe("PullView", () => {
  it("aggregates layered PullProgress events and refreshes models on success", async () => {
    const client = new FakeClient({ models: [] });
    const refreshSpy = vi.spyOn(client, "listGroups");
    renderPull(client);
    await untilChecked();

    submitPull("gemma2:9b");

    await act(async () => {
      client.emitPull({ status: "pulling manifest" });
    });
    await waitFor(() => expect(document.querySelector(".progress b")).toHaveTextContent("gemma2:9b"));

    await act(async () => {
      client.emitPull({ status: "pulling abc123", digest: "sha256:abc123", total: 100, completed: 30 });
    });
    await waitFor(() => expect(document.querySelector(".layer .lpct")).toHaveTextContent("30%"));
    expect(document.querySelector(".progress .pct")).toHaveTextContent("30%");

    await act(async () => {
      client.emitPull({ status: "pulling abc123", digest: "sha256:abc123", total: 100, completed: 100 });
    });
    await waitFor(() => expect(document.querySelector(".layer .lpct")).toHaveTextContent("done"));

    const callsBefore = refreshSpy.mock.calls.length;
    await act(async () => {
      client.emitPull({ status: "success" });
    });

    // Card clears back to the empty state and the model list was re-fetched.
    await waitFor(() => expect(document.querySelector(".progress")).not.toBeInTheDocument());
    expect(refreshSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("cancel aborts the stream and does not refresh models", async () => {
    const client = new FakeClient({ models: [] });
    const refreshSpy = vi.spyOn(client, "listGroups");
    renderPull(client);
    await untilChecked();

    submitPull("gemma2:9b");
    await act(async () => {
      client.emitPull({ status: "pulling abc", digest: "sha256:abc", total: 100, completed: 10 });
    });
    await waitFor(() => expect(document.querySelector(".progress b")).toHaveTextContent("gemma2:9b"));
    const callsBefore = refreshSpy.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.querySelector(".progress")).not.toBeInTheDocument());
    expect(refreshSpy.mock.calls.length).toBe(callsBefore);

    // The one-at-a-time guard is cleared: a fresh pull can start immediately.
    submitPull("codellama:13b");
    await waitFor(() => expect(document.querySelector(".progress b")).toHaveTextContent("codellama:13b"));
  });

  it("shows a failed pull's error inline with Retry, which re-attempts the same tag", async () => {
    const client = new FakeClient({
      models: [],
      pullEvents: [{ status: "pulling manifest" }],
      failPull: "registry unreachable",
    });
    renderPull(client);
    await untilChecked();

    submitPull("llama3.2");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("registry unreachable");
    expect(client.pullCalls).toEqual(["llama3.2"]);

    // A second attempt succeeds.
    client.failPull = undefined;
    client.pullEvents = [{ status: "success" }];
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(client.pullCalls).toEqual(["llama3.2", "llama3.2"]));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("marks an installed size chip and leaves the rest pullable", async () => {
    const client = new FakeClient({ models: [makeModel({ tag: "gemma2:2b" })] });
    renderPull(client);
    await untilChecked();

    const row = catalogRow("gemma2");
    expect(within(row).getByRole("button", { name: "2b" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "9b" })).toBeEnabled();

    const pullableRow = catalogRow("llama3.2");
    expect(within(pullableRow).getByRole("button", { name: "Pull" })).toBeEnabled();
  });

  it("marks a row installed when the bare name is installed", async () => {
    const client = new FakeClient({ models: [makeModel({ tag: "llama3.2:latest" })] });
    renderPull(client);
    await untilChecked();

    const row = catalogRow("llama3.2");
    expect(within(row).getByRole("button", { name: "Installed" })).toBeDisabled();
  });

  it("pulling a size chip sends name:size", async () => {
    const client = new FakeClient({ models: [] });
    renderPull(client);
    await untilChecked();

    fireEvent.click(within(catalogRow("qwen3")).getByRole("button", { name: "14b" }));

    await waitFor(() => expect(client.pullCalls).toEqual(["qwen3:14b"]));
  });

  it("disables pull actions while disconnected, but keeps search usable", async () => {
    const client = new FakeClient({ models: [], connected: false });
    renderPull(client);

    await waitFor(() =>
      expect(within(catalogRow("llama3.2")).getByRole("button", { name: "Pull" })).toBeDisabled(),
    );
    expect(barPullButton()).toBeDisabled();

    // Searching a bundled JSON file needs no server (SPEC §5.5).
    const input = screen.getByLabelText("Model to pull");
    expect(input).toBeEnabled();
    typeQuery("mixtral");
    await waitFor(() => expect(screen.getByText("Matching")).toBeInTheDocument());
  });

  it("keeps search usable while a pull is streaming", async () => {
    const client = new FakeClient({ models: [] });
    renderPull(client);
    await untilChecked();

    submitPull("gemma2:9b");
    await act(async () => {
      client.emitPull({ status: "pulling manifest" });
    });

    expect(screen.getByLabelText("Model to pull")).toBeEnabled();
    typeQuery("mixtral");
    await waitFor(() => expect(screen.getByText("Matching")).toBeInTheDocument());
  });

  it("no pull in progress shows just the bar and the catalog (SPEC §5.5 empty state)", async () => {
    const client = new FakeClient({ models: [] });
    renderPull(client);
    await untilChecked();

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("All models")).toBeInTheDocument();
  });

  it("Sidebar's Pull models button switches to the Pull view, keeping the chats sidebar", async () => {
    const client = new FakeClient({ models: [makeModel({ tag: "llama3.1:8b", isLoaded: true })] });
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Pull models" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Pull models" }));

    expect(await screen.findByLabelText("Pull models")).toBeInTheDocument();
    expect(screen.getByLabelText("Chats")).toBeInTheDocument();
    expect(screen.getByLabelText("Model to pull")).toBeInTheDocument();
  });
});

describe("catalog search", () => {
  it("filters the list as you type and reports the count", async () => {
    const client = new FakeClient({ models: [] });
    renderPull(client);
    await untilChecked();

    expect(screen.getByText("All models")).toBeInTheDocument();
    expect(document.querySelectorAll(".regrow").length).toBeGreaterThan(100);

    typeQuery("mixtral");

    await waitFor(() => expect(screen.getByText("Matching")).toBeInTheDocument());
    const rows = document.querySelectorAll(".regrow");
    expect(rows.length).toBeLessThan(10);
    expect(catalogRow("mixtral")).toBeInTheDocument();
  });

  it("finds a model by a tagged query like qwen3:8b", async () => {
    const client = new FakeClient({ models: [] });
    renderPull(client);
    await untilChecked();

    typeQuery("qwen3:8b");

    await waitFor(() => expect(catalogRow("qwen3")).toBeInTheDocument());
  });

  it("explains an empty result rather than showing a bare blank", async () => {
    const client = new FakeClient({ models: [] });
    renderPull(client);
    await untilChecked();

    typeQuery("zzz-not-a-real-model");

    await waitFor(() => expect(screen.getByText(/doesn.t know about it yet/)).toBeInTheDocument());
  });
});

describe("registry probe", () => {
  it("reports an existing model and its download size", async () => {
    const invoke = stubBridge(async () => ({
      exists: true,
      totalBytes: 2_019_393_189,
      resolved: "library/llama3.2:latest",
    }));
    const client = new FakeClient({ models: [] });
    renderPull(client);
    await untilChecked();

    typeQuery("llama3.2");

    await waitFor(() => expect(screen.getByText(/2\.0 GB to download/)).toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("probe_model", { reference: "llama3.2" });
  });

  it("reports a name the registry doesn't have", async () => {
    stubBridge(async () => ({ exists: false, totalBytes: 0, resolved: "library/nope:latest" }));
    const client = new FakeClient({ models: [] });
    renderPull(client);
    await untilChecked();

    typeQuery("nope");

    await waitFor(() => expect(screen.getByText(/isn.t in the registry/)).toBeInTheDocument());
  });

  it("says nothing when the lookup fails — offline is not proof of absence", async () => {
    stubBridge(async () => {
      throw "error sending request";
    });
    const client = new FakeClient({ models: [] });
    renderPull(client);
    await untilChecked();

    typeQuery("llama3.2");

    // Give the debounce and the rejected call time to settle.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByText(/isn.t in the registry/)).not.toBeInTheDocument();
    expect(screen.queryByText(/to download/)).not.toBeInTheDocument();
  });

  it("says nothing at all outside the desktop shell", async () => {
    // No __TAURI__ (cleared in beforeEach): a plain browser dev session.
    const client = new FakeClient({ models: [] });
    renderPull(client);
    await untilChecked();

    typeQuery("llama3.2");

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector(".probe")).toBeNull();

    // ...but the same query in the shell does render one, so this is really
    // asserting the fallback and not just that the probe never works.
    stubBridge(async () => ({ exists: true, totalBytes: 1, resolved: "library/llama3.2:latest" }));
    cleanup();
    renderPull(new FakeClient({ models: [] }));
    await untilChecked();
    typeQuery("llama3.2");
    await waitFor(() => expect(document.querySelector(".probe")).not.toBeNull());
  });

  it("debounces to one lookup per pause, not one per keystroke", async () => {
    const invoke = stubBridge(async () => ({
      exists: true,
      totalBytes: 1,
      resolved: "library/q:latest",
    }));
    const client = new FakeClient({ models: [] });
    renderPull(client);
    await untilChecked();

    typeQuery("q");
    typeQuery("qw");
    typeQuery("qwe");
    typeQuery("qwen3");

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("probe_model", { reference: "qwen3" });
  });
});
