import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders the Remuda shell with its initial (disconnected, unloaded) state", () => {
    render(<App />);
    expect(screen.getByText("Remuda")).toBeInTheDocument();
    // Before the first health check resolves, nothing is loaded or connected yet.
    expect(screen.getByText("No model loaded")).toBeInTheDocument();
    expect(screen.getByText("Not running")).toBeInTheDocument();
    expect(screen.getByText("Load a model, then start a chat")).toBeInTheDocument();
  });
});
