import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Settings } from "./Settings";
import { RemudaProvider } from "./state";
import { FakeClient } from "./test/FakeClient";

describe("Settings", () => {
  it("shows Healthy when the Test button's version() check succeeds", async () => {
    const client = new FakeClient({ connected: true, version: "0.5.4" });
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
    const client = new FakeClient({ failVersion: true });
    render(
      <RemudaProvider client={client} pollIntervalMs={1_000_000}>
        <Settings />
      </RemudaProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Unreachable"));
  });
});
