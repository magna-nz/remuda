import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";
import { RemudaProvider } from "./state";
import { FakeClient } from "./test/FakeClient";

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
});
