import "../chat/test/localStorage";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";
import { RemudaProvider } from "./state";
import { FakeClient } from "./test/FakeClient";
import { DEFAULT_BASE_URL } from "../api/types";

const SETTINGS_KEY = "remuda.settings.v1";

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
      serverUrl: DEFAULT_BASE_URL,
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

  it("Apply button appears only when the draft differs from the active URL", () => {
    const client = new FakeClient({ connected: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    // Initially, the draft matches the committed URL — no Apply button.
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();

    // Edit the URL — Apply should appear.
    fireEvent.change(screen.getByLabelText("Ollama server URL"), {
      target: { value: "http://10.0.0.5:11434" },
    });
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();

    // Click Apply — it should disappear and the URL should be persisted.
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    const stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}") as Record<string, unknown>;
    expect(stored.serverUrl).toBe("http://10.0.0.5:11434");
  });

  it("server URL persists and is loaded on remount (SPEC §5.6)", () => {
    const client = new FakeClient({ connected: true });
    const { unmount } = render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    // Change and apply a non-default URL.
    fireEvent.change(screen.getByLabelText("Ollama server URL"), {
      target: { value: "http://remote:11434" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    unmount();

    // A fresh mount should load the persisted URL into the input.
    render(
      <RemudaProvider client={new FakeClient({ connected: true })} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );
    expect(screen.getByLabelText("Ollama server URL")).toHaveValue("http://remote:11434");
  });
});
