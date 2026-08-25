import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OfflineBanner } from "./OfflineBanner";
import { RemudaProvider } from "./state";
import { FakeClient } from "./test/FakeClient";

describe("OfflineBanner", () => {
  it("appears when disconnected", async () => {
    const client = new FakeClient({ failVersion: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <OfflineBanner />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Ollama isn’t running.")).toBeInTheDocument();
  });

  it("does not appear once connected", async () => {
    const client = new FakeClient({ connected: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <OfflineBanner />
      </RemudaProvider>,
    );

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
