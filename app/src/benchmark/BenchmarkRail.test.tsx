/**
 * The BENCHMARKS rail group (docs/SPEC-round-two.md R7).
 *
 * The header is there before anything is in it, because the word has to be
 * encounterable somewhere before a benchmark exists.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BenchmarkRail } from "./BenchmarkRail";
import type { Benchmark } from "./types";

function makeBenchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    id: "bm-1",
    name: "Coding voice",
    prompts: [
      { id: "p1", text: "one" },
      { id: "p2", text: "two" },
    ],
    lanes: [
      { id: "l1", model: "gemma-4-31b:latest", modelfile: null },
      { id: "l2", model: "gemma-terse:latest", modelfile: "terse-v2" },
    ],
    runs: [
      { id: "r1", ranAt: "2026-08-01T10:00:00.000Z", seed: 1, partial: false, cells: [] },
    ],
    ...overrides,
  };
}

describe("the group", () => {
  it("names itself and offers a + even with nothing in it", () => {
    const onCreate = vi.fn();
    render(
      <BenchmarkRail
        benchmarks={[]}
        activeBenchmarkId={null}
        onOpen={() => {}}
        onCreate={onCreate}
        onDelete={() => {}}
      />,
    );
    expect((document.querySelector(".side-label") as HTMLElement).textContent).toContain(
      "Benchmarks",
    );
    expect(
      screen.getByText(/A benchmark runs one set of prompts through several models/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New benchmark" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("blocks + with a reason when there is no model to put in a lane", () => {
    render(
      <BenchmarkRail
        benchmarks={[]}
        activeBenchmarkId={null}
        canCreate={false}
        onOpen={() => {}}
        onCreate={() => {}}
        onDelete={() => {}}
      />,
    );
    const add = screen.getByRole("button", { name: "New benchmark" });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("title", "Load a model first");
  });

  it("lists a benchmark with its prompt, lane and run counts, and opens it", () => {
    const onOpen = vi.fn();
    render(
      <BenchmarkRail
        benchmarks={[makeBenchmark()]}
        activeBenchmarkId="bm-1"
        paneVisible
        onOpen={onOpen}
        onCreate={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByText("2 prompts · 2 lanes · 1 run")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Coding voice"));
    expect(onOpen).toHaveBeenCalledWith("bm-1");
    // The open one is marked as current, but only while its pane is showing.
    expect(document.querySelector(".sess-open")).toHaveAttribute("aria-current", "true");
  });

  it("hands deleting to the caller, which owns the confirm", () => {
    const onDelete = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <BenchmarkRail
        benchmarks={[makeBenchmark()]}
        activeBenchmarkId={null}
        onOpen={() => {}}
        onCreate={() => {}}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete benchmark Coding voice" }));
    expect(onDelete).toHaveBeenCalledWith("bm-1");
    // SPEC §8's confirm toggle lives in the store, so the rail must not put
    // a second dialog in front of it.
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
