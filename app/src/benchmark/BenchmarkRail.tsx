/**
 * The **BENCHMARKS** group in the chats rail (docs/SPEC-round-two.md R7;
 * docs/mockup-proposals-2.html §01 `.side-label`).
 *
 * It sits above Recent because the rail persists across every surface
 * (SPEC §5) — which means a benchmark is reachable from inside the Modelfile
 * editor, which is exactly where you are standing when you want to run one.
 *
 * The header is shown even with nothing in it. Someone who has never made a
 * benchmark has to encounter the word somewhere, and an empty group with one
 * line of explanation is cheaper to find than any tooltip.
 *
 * The store does not exist yet, so this takes the list and its callbacks as
 * props. Deleting **confirms in the caller**, under the SPEC §8 toggle the
 * store already owns; there is deliberately no `window.confirm` here.
 *
 * `+` is **never disabled**. Creating a benchmark has no residency
 * precondition: lane choices come from every installed model
 * (`BenchmarkPane.laneChoices`) and the weights are only needed at Run, so an
 * unconfigured lane is a valid state the lane editor exists to resolve.
 */
import "./BenchmarkRail.css";
import { benchmarkSubtitle } from "./benchmarks";
import type { Benchmark } from "./types";

export interface BenchmarkRailProps {
  benchmarks: Benchmark[];
  activeBenchmarkId: string | null;
  /** True when the Benchmark pane is the one on screen. */
  paneVisible?: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
  /** The caller confirms before it deletes (SPEC §8). */
  onDelete: (id: string) => void;
  /**
   * The tour's target for the BENCHMARKS header, passed in rather than
   * registered here so `tour/steps.ts` stays the caller's file.
   */
  headerRef?: (el: HTMLElement | null) => void;
}

export function BenchmarkRail({
  benchmarks,
  activeBenchmarkId,
  paneVisible = false,
  onOpen,
  onCreate,
  onDelete,
  headerRef,
}: BenchmarkRailProps) {
  return (
    <>
      <div className="side-label" ref={headerRef}>
        Benchmarks
        <button
          type="button"
          className="side-add"
          title="New benchmark"
          aria-label="New benchmark"
          onClick={onCreate}
        >
          +
        </button>
      </div>
      <div className="benchmarklist">
        {benchmarks.length === 0 ? (
          <p className="empty-note">
            A benchmark runs one set of prompts through several models side by side. Make one
            with +, then add prompts from any chat.
          </p>
        ) : (
          benchmarks.map((benchmark) => {
            const active = paneVisible && benchmark.id === activeBenchmarkId;
            return (
              <div key={benchmark.id} className={active ? "sess active" : "sess"}>
                <button
                  type="button"
                  className="sess-open"
                  aria-current={active || undefined}
                  title={benchmark.lanes.map((lane) => lane.model).join(", ")}
                  onClick={() => onOpen(benchmark.id)}
                >
                  <div className="strow">
                    <span className="stitle">{benchmark.name}</span>
                  </div>
                  <div className="smodel">{benchmarkSubtitle(benchmark)}</div>
                </button>
                <button
                  type="button"
                  className="sess-x"
                  title={`Delete ${benchmark.name}`}
                  aria-label={`Delete benchmark ${benchmark.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(benchmark.id);
                  }}
                >
                  &times;
                </button>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
