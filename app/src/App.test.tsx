import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";
import { FakeClient } from "./ui/test/FakeClient";

describe("App", () => {
  it("renders the Remuda shell with its initial (disconnected, unloaded) state", () => {
    // Inject a FakeClient so the test issues no real network requests.
    const client = new FakeClient();
    client.connected = false;
    render(<App client={client} />);
    expect(screen.getByText("Remuda")).toBeInTheDocument();
    // Before the first health check resolves, nothing is loaded or connected yet.
    expect(screen.getByText("No model loaded")).toBeInTheDocument();
    expect(screen.getByText("Not running")).toBeInTheDocument();
    expect(screen.getByText("Load a model, then start a chat")).toBeInTheDocument();
  });
});
