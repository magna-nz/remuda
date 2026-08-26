import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TopNav } from "./TopNav";
import { RemudaProvider } from "./state";
import { FakeClient, makeModel } from "./test/FakeClient";

describe("TopNav", () => {
  it("shows disconnected state when version() fails", async () => {
    const client = new FakeClient({ failVersion: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByText("Not running")).toBeInTheDocument());
    expect(screen.getByText("No model loaded")).toBeInTheDocument();
  });

  it("shows plain Connected (no vnull) when connected but version is null", async () => {
    const client = new FakeClient({ connected: true, version: null });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
    expect(screen.queryByText(/vnull/)).not.toBeInTheDocument();
  });

  it("shows the runtime chip amber when the loaded model spills to CPU (SPEC §5.1)", async () => {
    const client = new FakeClient({
      models: [makeModel({ tag: "llama3.1:8b", isLoaded: true, sizeBytes: 4_700_000_000 })],
      running: [
        {
          tag: "llama3.1:8b",
          sizeBytes: 4_700_000_000,
          sizeVramBytes: 2_350_000_000,
          contextLength: 8192,
          expiresAt: null,
        },
      ],
    });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
      </RemudaProvider>,
    );

    const chip = await screen.findByText("50% GPU");
    expect(chip).toHaveClass("rt-inline", "spill");
  });

  it("omits the runtime chip when nothing is loaded", async () => {
    const client = new FakeClient({ models: [] });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <TopNav />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByText("No model loaded")).toBeInTheDocument());
    expect(screen.queryByText(/% GPU/)).not.toBeInTheDocument();
  });
});
