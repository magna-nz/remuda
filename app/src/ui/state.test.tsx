/**
 * Provider polling (SPEC.md §8, §9).
 *
 * The health poll used to only ask /api/version, and rebuilt the model list
 * solely on a disconnected→connected transition. That left Remuda blind to
 * anything that changed the store from outside — `ollama pull` in a
 * terminal, `ollama rm`, another client. These cover the cheap reconcile
 * that fixes it, and the cost guard that keeps it cheap.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RemudaProvider, useRemuda } from "./state";
import { FakeClient, makeModel } from "./test/FakeClient";

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