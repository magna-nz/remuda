import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TopNav } from "./TopNav";
import { RemudaProvider } from "./state";
import { FakeClient } from "./test/FakeClient";

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
});
