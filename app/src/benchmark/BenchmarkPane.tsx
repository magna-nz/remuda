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
import { useMemo, useState } from "react";
import { BenchmarkView } from "./BenchmarkView";
import type { LaneChoice } from "./LaneEditor";
import { newLaneId } from "./benchmarks";
import { preflight, type Preflight } from "./preflight";
import { RunPreflight } from "./RunPreflight";
import type { Lane } from "./types";
import { useRemuda } from "../ui/state";
import { useUsableVram } from "../ui/useUsableVram";
import { calibrationFactorFor } from "../models/fitCalibration";

/**
 * The context assumed for a lane when **nothing has been loaded yet** to
 * observe one.
 *
 * Not "Ollama's default" — there isn't a fixed one to name. Remuda sends no
 * `num_ctx` for a benchmark (run.ts), and recent Ollama sizes the context to
 * available memory: a 27B q8 on a 52 GB machine was observed starting at
 * 26,624, not at this figure. `observedCtx` therefore prefers what /api/ps
 * reports and falls back here only when no runner is resident — which is also
 * the case where there is no collision to miss.
 */
export const FALLBACK_RUN_CTX = 4096;

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
    models,
    running,
    unload,
  } = useRemuda();
  const usableVramBytes = useUsableVram();
  // Asked at Run, not on every keystroke: this is the blocking gate, and the
  // lane rows carry the same verdicts passively as lanes are edited.
  const [pending, setPending] = useState<Preflight | null>(null);

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

  const checkLanes = (): Preflight | null =>
    benchmark === null
      ? null
      : preflight({
          lanes: benchmark.lanes,
          models,
          running,
          usableVramBytes,
          fallbackCtx: FALLBACK_RUN_CTX,
          calibrationFactorFor,
        });

  const start = () => {
    if (benchmark !== null) void startBenchmarkRun(benchmark.id);
  };

  return (
    <>
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
        // Only a collision stops the run to ask. Everything else the check
        // knows is already on the lane rows.
        const result = checkLanes();
        if (result !== null && result.needsUnload) {
          setPending(result);
          return;
        }
        start();
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
      laneVerdicts={checkLanes()?.lanes ?? []}
    />
    {pending !== null && (
      <RunPreflight
        preflight={pending}
        onCancel={() => setPending(null)}
        onRunAnyway={() => {
          setPending(null);
          start();
        }}
        onUnloadAndRun={() => {
          const blockers = pending.blockers.map((b) => b.tag);
          setPending(null);
          // Deliberately not reloaded afterwards: this matches Eject, and a
          // surprise load landing after a long run is nobody's request. The
          // chat that was using it reloads on its next message.
          void Promise.all(blockers.map((tag) => unload(tag))).then(start, start);
        }}
      />
    )}
    </>
  );
}
