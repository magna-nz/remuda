import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders the Remuda shell", () => {
    render(<App />);
    expect(screen.getByText("Remuda")).toBeInTheDocument();
  });
});
