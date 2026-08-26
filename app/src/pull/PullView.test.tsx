import "../chat/test/localStorage";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** Wait for the first health check to populate the model list / connection. */
async function untilChecked() {
  await waitFor(() => expect(screen.getByLabelText("Model to pull")).toBeEnabled());
}

/**
 * The pull bar's own "Pull" button, scoped away from the Popular list's rows
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
 * A Popular row by its exact tag — scoped to `.regrow .rt b`, since the tag
 * text also appears (as an example) in the note-strip's `<code>`.
 */
function popularRow(tag: string): HTMLElement {
  const heading = screen.getAllByText(tag, { selector: ".regrow .rt b" })[0];
  return heading.closest(".regrow") as HTMLElement;
}

beforeEach(() => {
  window.localStorage.clear();
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

  it("marks Popular rows already installed and disables their Pull button", async () => {
    const client = new FakeClient({ models: [makeModel({ tag: "gemma2:2b" })] });
    renderPull(client);
    await untilChecked();

    const installedRow = popularRow("gemma2:2b");
    expect(within(installedRow).getByRole("button", { name: "Installed" })).toBeDisabled();

    const pullableRow = popularRow("llama3.2");
    expect(within(pullableRow).getByRole("button", { name: "Pull" })).toBeEnabled();
  });

  it("disables pull actions while disconnected", async () => {
    const client = new FakeClient({ models: [], connected: false });
    renderPull(client);

    await waitFor(() => expect(screen.getByLabelText("Model to pull")).toBeDisabled());
    const pullableRow = popularRow("llama3.2");
    expect(within(pullableRow).getByRole("button", { name: "Pull" })).toBeDisabled();
  });

  it("no pull in progress shows just the bar and Popular (SPEC §5.5 empty state)", async () => {
    const client = new FakeClient({ models: [] });
    renderPull(client);
    await untilChecked();

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Popular")).toBeInTheDocument();
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
