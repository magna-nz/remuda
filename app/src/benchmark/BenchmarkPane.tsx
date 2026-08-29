/**
 * The container that binds the Benchmark views to the store
 * (docs/SPEC-round-two.md R7).
 *
 * `BenchmarkView` and `LaneEditor` are deliberately prop-driven and know
 * nothing about `useRemuda`, which is what let them be built and tested
 * against fixtures while the store was still being rewritten. This file is
 * the one place the two halves meet, so there is exactly one seam to read
 * when the wiring is wrong.
 */
import { useMemo } from "react";
import { BenchmarkView } from "./BenchmarkView";
import type { LaneChoice } from "./LaneEditor";
import { newLaneId } from "./benchmarks";
import type { Lane } from "./types";
import { useRemuda } from "../ui/state";

/**
 * Every configuration a lane may be set to: each installed base model, plus
 * each variant built from it.
 *
 * Flattened here rather than in the editor because the *store* is what knows
 * which tags exist; `groups` already carries the base/variant relation that
 * `Lane` cannot express on its own (a variant's `model` is its own tag, so
 * the base it came from would otherwise be unrecoverable).
 */
function laneChoices(groups: ReturnType<typeof useRemuda>["groups"]): LaneChoice[] {
  return groups.flatMap((group) => [
    { base: group.base.tag, model: group.base.tag, modelfile: null },
    ...group.variants.map((variant) => ({
      base: group.base.tag,
      model: variant.tag,
      modelfile: variant.tag,
    })),
  ]);
}

export function BenchmarkPane() {
  const {
    benchmarks,
    activeBenchmarkId,
    benchmarkProgress,
    groups,
    startBenchmarkRun,
    cancelBenchmarkRun,
    removeBenchmarkPrompt,
    renameBenchmark,
    addLane,
    removeLane,
    updateLane,
    streamingSessionId,
    compareRun,
  } = useRemuda();

  const benchmark = benchmarks.find((b) => b.id === activeBenchmarkId) ?? null;
  const choices = useMemo(() => laneChoices(groups), [groups]);

  /**
   * The editor hands back the lanes it wants, whole. Diffing them against
   * what the store holds keeps the store's API in terms of single
   * operations, which is what `commitBenchmarks` and the run cap are written
   * against, rather than a wholesale replace that could drop a lane's id and
   * orphan its cells in past runs.
   */
  function applyLanes(next: Lane[]) {
    if (benchmark === null) return;
    const before = benchmark.lanes;
    for (const lane of before) {
      if (!next.some((l) => l.id === lane.id)) removeLane(benchmark.id, lane.id);
    }
    for (const lane of next) {
      const existing = before.find((l) => l.id === lane.id);
      if (existing === undefined) {
        addLane(benchmark.id, lane.model, lane.modelfile);
      } else if (existing.model !== lane.model || existing.modelfile !== lane.modelfile) {
        updateLane(benchmark.id, lane.id, { model: lane.model, modelfile: lane.modelfile });
      }
    }
  }

  return (
    <BenchmarkView
      benchmark={benchmark}
      // Only this benchmark's run: the store holds one at a time, but a
      // stale id would paint another benchmark's cells into this table.
      live={
        benchmarkProgress !== null && benchmark !== null &&
        benchmarkProgress.benchmarkId === benchmark.id
          ? benchmarkProgress
          : null
      }
      choices={choices}
      // SPEC §8 is app-wide: a benchmark queues behind a chat or a compare,
      // and the button says so rather than silently refusing.
      elsewhereBusy={streamingSessionId !== null || compareRun !== null}
      onRunAll={() => {
        if (benchmark !== null) void startBenchmarkRun(benchmark.id);
      }}
      onCancel={cancelBenchmarkRun}
      onLanesChange={applyLanes}
      onRemovePrompt={(promptId) => {
        if (benchmark !== null) removeBenchmarkPrompt(benchmark.id, promptId);
      }}
      onRename={(name) => {
        if (benchmark !== null) renameBenchmark(benchmark.id, name);
      }}
      makeLaneId={newLaneId}
    />
  );
}
