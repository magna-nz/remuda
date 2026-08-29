import "../chat/test/localStorage";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCS_BASE_URL, Settings } from "./Settings";
import { RemudaProvider } from "./state";
import { FakeClient } from "./test/FakeClient";
import { GLOSSARY } from "../help/glossary";
import { isPaneHelpOpen, setPaneHelpOpen } from "../help/persistence";

const SETTINGS_KEY = "remuda.settings.v1";

/**
 * Stand in for the Tauri bridge that `withGlobalTauri` injects (mirrors
 * `api/host.test.ts`'s helper — that file is out of this section's scope, so
 * this is its own copy rather than a shared import).
 */
function stubBridge(impl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const invoke = vi.fn(impl);
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
  return invoke;
}

/** A minimal Response-shaped object covering what client.ts's version() touches. */
function jsonResponse(data: unknown, status = 200): Response {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  } as unknown as Response;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

describe("Settings", () => {
  it("shows Healthy when the Test button's version() check succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({ version: "0.5.4" })),
    );
    // The store's client is unrelated to what Test exercises now — it must
    // stay disconnected to prove the pill reflects Test's own check.
    const client = new FakeClient({ connected: false });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    // Query the Test-button's own result pill (role="status"), not the
    // separate Connection readout, which can independently say "Healthy".
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Healthy"));
  });

  it("shows Unreachable when the Test button's version() check fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const client = new FakeClient({ connected: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Unreachable"));
  });

  it("tests the URL typed into the field, not the store client's URL", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => jsonResponse({ version: "9.9.9" }));
    vi.stubGlobal("fetch", fetchStub);
    const client = new FakeClient({ connected: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    fireEvent.change(screen.getByLabelText("Ollama server URL"), {
      target: { value: "http://127.0.0.1:9999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Healthy"));
    expect(String(fetchStub.mock.calls[0][0])).toBe("http://127.0.0.1:9999/api/version");
  });

  it("shows plain Connected (no vnull) in the Connection readout when version is null", async () => {
    const client = new FakeClient({ connected: true, version: null, models: [] });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByText(/^Connected ·/)).toBeInTheDocument());
    expect(screen.queryByText(/vnull/)).not.toBeInTheDocument();
  });

  it("'Confirm before deleting a model' defaults on and persists across a fresh mount (SPEC §5.6)", () => {
    const client = new FakeClient({ connected: true });
    const { unmount } = render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    const toggle = screen.getByRole("switch", { name: "Confirm before deleting a model" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}")).toEqual({
      confirmDeleteModel: false,
    });
    unmount();

    // A fresh provider (new mount, same localStorage) picks up the persisted value.
    render(
      <RemudaProvider client={new FakeClient({ connected: true })} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );
    expect(screen.getByRole("switch", { name: "Confirm before deleting a model" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});

describe("Help section (R5)", () => {
  it("renders the guided tour row disabled, since the tour isn't built yet", () => {
    const client = new FakeClient({ connected: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    expect(screen.getByRole("button", { name: "Run the tour" })).toBeDisabled();
  });

  it("'Reopen all' restores a pane dismissed elsewhere", () => {
    setPaneHelpOpen("format", false);
    expect(isPaneHelpOpen("format")).toBe(false);

    const client = new FakeClient({ connected: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reopen all" }));
    expect(isPaneHelpOpen("format")).toBe(true);
  });

  it("lists every glossary term with its definition", () => {
    const client = new FakeClient({ connected: true });
    const { container } = render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    // Scoped to the glossary list itself: a couple of these words (e.g.
    // `keep_alive`) already appear elsewhere in Settings as plain `<code>`.
    const list = container.querySelector(".glossary-list") as HTMLElement;
    expect(list).toBeInTheDocument();
    const entries = Object.values(GLOSSARY);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(within(list).getByText(entry.term)).toBeInTheDocument();
      expect(within(list).getByText(entry.definition)).toBeInTheDocument();
    }
  });
});

describe("Documentation section (T8)", () => {
  it("renders its links: a few deep links plus the repository, not one undifferentiated 'Docs' link", () => {
    const client = new FakeClient({ connected: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    expect(screen.getByRole("button", { name: "Getting started" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "The Modelfile editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Troubleshooting" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repository" })).toBeInTheDocument();
  });

  it("clicking a link calls the bridge with the expected https:// URL, in the system browser not an <a>", () => {
    const invoke = stubBridge(async () => null);
    const client = new FakeClient({ connected: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Getting started" }));

    expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", {
      url: `${DOCS_BASE_URL}getting-started.html`,
    });
  });

  it("clicking outside the desktop shell rejects without an unhandled rejection, and surfaces the message", async () => {
    const client = new FakeClient({ connected: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    // No __TAURI__ bridge stubbed: openExternal rejects with "…desktop app…".
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/desktop app/));
  });

  it("surfaces a bridge failure rather than swallowing it", async () => {
    stubBridge(async () => {
      throw "url not allowed on the configured scope";
    });
    const client = new FakeClient({ connected: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Troubleshooting" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/url not allowed on the configured scope/),
    );
  });
});
