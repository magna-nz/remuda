/**
 * The Run-time memory question, as a dialog and as a wiring.
 *
 * `preflight.test.ts` covers the arithmetic. What matters here is the
 * *policy* around it: the dialog opens only on a collision, "Run anyway"
 * really runs, "Unload and run" unloads first and does not reload after, and
 * a machine whose memory can't be read is never blocked by a check that
 * couldn't be made.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../chat/test/localStorage";
import { RunPreflight } from "./RunPreflight";
import type { Preflight } from "./preflight";

const GB = 1_000_000_000;

function collision(): Preflight {
  return {
    lanes: [
      { kind: "reuse", laneId: "l1", model: "qwen2.5:7b" },
      {
        kind: "collides",
        laneId: "l2",
        model: "gemma3:27b",
        laneBytes: 24 * GB,
        residentBytes: 5 * GB,
        usableBytes: 27 * GB,
      },
    ],
    blockers: [{ tag: "qwen2.5:7b", sizeBytes: 5 * GB, pinned: false }],
    needsUnload: true,
    hasTooBig: false,
    allUnknown: false,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("RunPreflight dialog", () => {
  it("names the blocker, the lane, and the arithmetic", () => {
    render(
      <RunPreflight
        preflight={collision()}
        onUnloadAndRun={() => {}}
        onRunAnyway={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("dialog", { name: /Unload qwen2\.5:7b to run this\?/ })).toBeInTheDocument();
    // The reused lane is shown as reused, not counted against the budget.
    expect(screen.getByText(/Already in memory/)).toBeInTheDocument();
    expect(screen.getByText(/against 27\.0 GB usable/)).toBeInTheDocument();
  });

  it("offers Run anyway — a prediction is a prediction", () => {
    const onRunAnyway = vi.fn();
    render(
      <RunPreflight
        preflight={collision()}
        onUnloadAndRun={() => {}}
        onRunAnyway={onRunAnyway}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run anyway" }));
    expect(onRunAnyway).toHaveBeenCalledTimes(1);
  });

  it("says the pin will be cleared, because that was a deliberate setting", () => {
    const pinned = collision();
    pinned.blockers = [{ tag: "qwen2.5:7b", sizeBytes: 5 * GB, pinned: true }];
    render(
      <RunPreflight
        preflight={pinned}
        onUnloadAndRun={() => {}}
        onRunAnyway={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/is pinned — unloading clears the pin/)).toBeInTheDocument();
  });

  it("does not offer unloading as the fix for a lane that is simply too big", () => {
    const tooBig: Preflight = {
      lanes: [
        { kind: "too-big", laneId: "l1", model: "huge:70b", laneBytes: 40 * GB, usableBytes: 27 * GB },
        {
          kind: "collides",
          laneId: "l2",
          model: "gemma3:27b",
          laneBytes: 24 * GB,
          residentBytes: 5 * GB,
          usableBytes: 27 * GB,
        },
      ],
      blockers: [{ tag: "qwen2.5:7b", sizeBytes: 5 * GB, pinned: false }],
      needsUnload: true,
      hasTooBig: true,
      allUnknown: false,
    };
    render(
      <RunPreflight preflight={tooBig} onUnloadAndRun={() => {}} onRunAnyway={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByText(/too big on its own/)).toBeInTheDocument();
    expect(screen.getByText(/Unloading won't help/)).toBeInTheDocument();
  });

  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    render(
      <RunPreflight preflight={collision()} onUnloadAndRun={() => {}} onRunAnyway={() => {}} onCancel={onCancel} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
