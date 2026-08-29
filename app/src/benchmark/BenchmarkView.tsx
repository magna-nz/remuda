/**
 * The benchmark table (docs/SPEC-round-two.md R7;
 * docs/mockup-proposals-2.html §01 `.benchhead` / `.runbar` / `.brow` /
 * `.bcol`).
 *
 * R4's bench compared one configuration against **its own past**. A
 * benchmark turns that axis ninety degrees and compares **several
 * configurations against each other** over the same prompts: one row per
 * prompt, one column per lane. Expanding a row word-diffs every lane past
 * the first against the first, reusing the word diff rather than growing a
 * second one.
 *
 * The rule the whole surface is built around: **different is a diff, never a
 * verdict.** No cell is scored, no lane is called better or winning, and the
 * table is never sorted by anything but prompt order. Both facts live in
 * rows.ts, which this file renders and does not second-guess.
 *
 * **Loading is shown, not hidden.** A lane switch on a 20 GB model takes
 * real time, and a UI that looks hung for a minute is the failure mode this
 * feature has. The run bar names the model being loaded and the lane it is
 * for, in an `aria-live` region so it is announced rather than only drawn.
 *
 * The store does not exist yet: every input arrives as a prop and the caller
 * owns persistence and the run loop.
 */
import { useMemo, useState } from "react";
import "./BenchmarkView.css";
import { BenchmarkEmpty } from "./BenchmarkEmpty";
import { LaneEditor, laneChipLabel, type LaneChoice } from "./LaneEditor";
import { runLabel } from "./benchmarks";
import {
  CELL_BADGE,
  ROW_BADGE,
  buildRows,
  cellSnippet,
  formatDuration,
  tally,
  tallyParts,
  type BenchmarkRow,
  type RowCell,
} from "./rows";
import type { BenchmarkProgress } from "./run";
import type { Benchmark, BenchmarkRun, Cell, Lane } from "./types";
import { diffWords, newSide, oldSide, type WordChunk } from "./words";
import { PaneHelp, PaneHelpToggle } from "../help/PaneHelp";
import { Term } from "../help/Term";
import { shortTag } from "../chat/sessions";

/**
 * A run in flight, as the store holds it.
 *
 * Shaped around `runBenchmark`'s two callbacks rather than invented here:
 * `progress` is whatever `onProgress` last reported, `cells` is what
 * `onCell` has settled. `seed` is the store's, drawn once for the whole run
 * — one seed across every lane and every prompt is the point, and a view
 * that recomputed it per lane would be measuring sampling noise.
 */
export interface LiveBenchmarkRun {
  seed: number;
  cells: Cell[];
  /** null between pressing Run all and the runner's first report. */
  progress: BenchmarkProgress | null;
}

export interface BenchmarkViewProps {
  /** null renders the "nothing open" note; the rail is still reachable. */
  benchmark: Benchmark | null;
  /** Non-null only while *this* benchmark is running. */
  live: LiveBenchmarkRun | null;
  /** What the lane editor may offer. */
  choices: LaneChoice[];
  /** Something else is generating: SPEC §8 is one generation, app-wide. */
  elsewhereBusy?: boolean;
  onRunAll: () => void;
  onCancel: () => void;
  onLanesChange: (lanes: Lane[]) => void;
  /** Omit to hide the per-prompt remove control. */
  onRemovePrompt?: (promptId: string) => void;
  /** Omit to hide the rename control. */
  onRename?: (name: string) => void;
  /** Handed to the lane editor, so a test can pin the ids of new lanes. */
  makeLaneId?: () => string;
}

/** "14:22" — the run picker's time, in the reader's own locale. */
function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function Chunks({ chunks }: { chunks: WordChunk[] }) {
  return (
    <>
      {chunks.map((chunk, i) =>
        chunk.kind === "del" ? (
          <del key={i}>{chunk.text}</del>
        ) : chunk.kind === "add" ? (
          <ins key={i}>{chunk.text}</ins>
        ) : (
          <span key={i}>{chunk.text}</span>
        ),
      )}
    </>
  );
}

function Column({
  head,
  note,
  cell,
  chunks,
}: {
  head: string;
  note: string;
  cell: Cell | null;
  chunks: WordChunk[] | null;
}) {
  return (
    <div className="bcol">
      <div className="bcol-h">
        <b>{head}</b>
        <span className="bcol-note">{note}</span>
      </div>
      <div className="bcol-b">
        {cell === null ? (
          <span className="bcol-none">no answer</span>
        ) : cell.error !== undefined ? (
          // A failed cell is a result, kept with its cause verbatim (SPEC
          // §9) — a context-length failure is exactly what a benchmark is
          // for. Whatever the lane managed first is kept below it rather
          // than thrown away.
          <>
            <span className="bcol-err">{cell.error}</span>
            {cell.content !== "" && <span className="bcol-part">{cell.content}</span>}
          </>
        ) : chunks !== null ? (
          <Chunks chunks={chunks} />
        ) : (
          cell.content
        )}
      </div>
      {cell?.stats !== undefined && (
        <div className="bfoot">
          <span>{cell.stats.evalCount} tok</span>
          {cell.stats.tokPerSec !== null && <span>{cell.stats.tokPerSec} tok/s</span>}
          <span>{formatDuration(cell)}</span>
        </div>
      )}
    </div>
  );
}

function PromptRow({
  row,
  choices,
  expanded,
  onToggle,
  onRemove,
}: {
  row: BenchmarkRow;
  choices: LaneChoice[];
  expanded: boolean;
  onToggle: () => void;
  onRemove: (() => void) | null;
}) {
  // Every lane past the first, diffed against the first — never lane against
  // lane in both directions. Only where both sides are real answers: an
  // error has no words to align.
  const chunks = useMemo(() => {
    const baseline = row.cells[0]?.cell ?? null;
    return row.cells.map(({ cell }, i) => {
      if (i === 0 || baseline === null || cell === null) return null;
      if (baseline.error !== undefined || cell.error !== undefined) return null;
      return diffWords(baseline.content, cell.content);
    });
  }, [row.cells]);

  // The collapsed line: a failure if there is one, because that is the thing
  // you most need to know without opening the row, else lane 1's answer.
  const lead: RowCell | undefined =
    row.cells.find((c) => c.cell !== null && c.cell.error !== undefined) ?? row.cells[0];
  const number = String(row.number).padStart(2, "0");
  const laneCount = row.cells.length;

  return (
    <div className="brow">
      <button type="button" className="brow-h" aria-expanded={expanded} onClick={onToggle}>
        <span className="brow-n">{number}</span>
        <span className="brow-p">
          {row.prompt.text}
          {lead !== undefined && lead.cell !== null && (
            <span className={lead.cell.error !== undefined ? "sn err" : "sn"}>
              {cellSnippet(lead.cell)}
            </span>
          )}
        </span>
        <span className={`bbadge ${row.state}`}>{ROW_BADGE[row.state]}</span>
      </button>
      {onRemove !== null && (
        <button
          type="button"
          className="brow-x"
          title="Remove this prompt"
          aria-label={`Remove prompt ${String(row.number)}`}
          onClick={onRemove}
        >
          &times;
        </button>
      )}
      {expanded && (
        <div
          className="brow-b"
          style={{ gridTemplateColumns: `repeat(${String(laneCount)}, minmax(0, 1fr))` }}
        >
          {row.cells.map(({ lane, cell, state }, i) => {
            // With exactly two lanes the first column carries the deletions,
            // which is what makes the pair read as one diff. With more, the
            // first column is the reference the others are measured against
            // and cannot be marked up several ways at once.
            const own = i === 0 ? (laneCount === 2 ? (chunks[1] ?? null) : null) : (chunks[i] ?? null);
            const side =
              own === null ? null : i === 0 && laneCount === 2 ? oldSide(own) : newSide(own);
            return (
              <Column
                key={lane.id}
                head={`Lane ${String(i + 1)} · ${laneChipLabel(lane, choices)}`}
                note={state === "baseline" ? "the reference" : CELL_BADGE[state]}
                cell={cell}
                chunks={side}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export function BenchmarkView({
  benchmark,
  live,
  choices,
  elsewhereBusy = false,
  onRunAll,
  onCancel,
  onLanesChange,
  onRemovePrompt,
  onRename,
  makeLaneId,
}: BenchmarkViewProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const shown: BenchmarkRun | null = useMemo(() => {
    if (benchmark === null) return null;
    if (live !== null) {
      // The run in flight, as a run: the table fills in as cells settle
      // rather than staying blank until the last lane is done.
      return {
        id: "live",
        ranAt: new Date().toISOString(),
        seed: live.seed,
        partial: true,
        cells: live.cells,
      };
    }
    if (selectedRunId !== null) {
      const picked = benchmark.runs.find((r) => r.id === selectedRunId);
      if (picked !== undefined) return picked;
    }
    return benchmark.runs[0] ?? null;
  }, [benchmark, live, selectedRunId]);

  const rows = useMemo(
    () => (benchmark === null ? [] : buildRows(benchmark, shown)),
    [benchmark, shown],
  );
  const parts = useMemo(() => tallyParts(tally(rows)), [rows]);

  if (benchmark === null) {
    return (
      <div className="benchmarkview">
        <p className="empty-note">No benchmark is open. Pick one from the rail, or make one.</p>
      </div>
    );
  }

  const progress = live?.progress ?? null;
  const blocked =
    benchmark.prompts.length === 0
      ? "Add a prompt first"
      : benchmark.lanes.length === 0
        ? "Add a lane first"
        : elsewhereBusy
          ? "Something else is generating. Remuda runs one at a time"
          : null;

  return (
    <div className="benchmarkview">
      <div className="benchhead">
        <b>{benchmark.name}</b>
        {onRename !== undefined && (
          <button
            type="button"
            className="benchrename"
            title="Rename this benchmark"
            aria-label={`Rename benchmark ${benchmark.name}`}
            onClick={() => {
              const name = window.prompt("Name this benchmark", benchmark.name);
              if (name !== null) onRename(name);
            }}
          >
            &#9998;
          </button>
        )}
        <span className="bmeta">
          {benchmark.prompts.length === 0
            ? "no prompts yet"
            : `${String(benchmark.prompts.length)} ${benchmark.prompts.length === 1 ? "prompt" : "prompts"}`}
        </span>
        {/* One chip per configuration. It carries the Modelfile, not just
            the model, because two lanes on one model differ in nothing
            else. */}
        <span className="lanechips">
          {benchmark.lanes.map((lane) => (
            <span key={lane.id} className="lanechip">
              {laneChipLabel(lane, choices)}
            </span>
          ))}
        </span>
        <span className="spacer" />
        {benchmark.runs.length > 0 && live === null && (
          <select
            className="runsel"
            aria-label="Run to show"
            value={shown?.id ?? ""}
            onChange={(e) => setSelectedRunId(e.target.value)}
          >
            {benchmark.runs.map((run) => (
              <option key={run.id} value={run.id}>
                {`${runLabel(benchmark, run.id)} · ${clockTime(run.ranAt)}${run.partial ? " · partial" : ""}`}
              </option>
            ))}
          </select>
        )}
        {live !== null ? (
          <button type="button" className="btn sm" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn sm primary"
            // The same SPEC §8 guard the store enforces. Without it the
            // button looks live during a chat stream and does nothing.
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={onRunAll}
          >
            Run all
          </button>
        )}
        <PaneHelpToggle paneId="benchmark" label="About benchmarks" />
      </div>

      {/* Always reachable, unlike the empty state, which disappears the
          moment a benchmark has a prompt in it. */}
      <PaneHelp
        paneId="benchmark"
        title={
          <>
            <Term name="benchmark">Benchmark</Term>, several setups over the same prompts
          </>
        }
        what="A saved set of prompts, run through several configurations at once. One row per prompt, one column per lane, and the answers side by side."
        why="The settings tell you what you changed. A benchmark tells you what the change sounds like, on the prompts you actually care about getting right."
        steps={[
          <>
            Give each lane a model and a <Term name="Modelfile">Modelfile</Term>. Two lanes on
            the same model under different Modelfiles is the usual pair.
          </>,
          <>
            Add prompts from any chat. The <b>⌄</b> under a message, then{" "}
            <b>Add to benchmark</b>. It is on the reply as well as the prompt.
          </>,
          <>
            Press <b>Run all</b>. Every lane answers every prompt on one pinned{" "}
            <Term name="seed">seed</Term>. Lanes go one at a time, because only one model is
            resident at once, so a lane change is a full load and the bar says so while it
            happens.
          </>,
        ]}
        note="Different is a diff, not a verdict. Remuda never says which lane won."
      />

      <LaneEditor
        lanes={benchmark.lanes}
        choices={choices}
        disabled={live !== null}
        onChange={onLanesChange}
        makeLaneId={makeLaneId}
      />

      {benchmark.prompts.length === 0 ? (
        <BenchmarkEmpty />
      ) : (
        <>
          <div className="runbar">
            {live !== null ? (
              /* Shown, not hidden: a 20 GB lane change is a minute of
                 nothing, and `role="status"` means it is announced as well
                 as drawn. */
              <span className="bloading" role="status">
                <span className="spin" aria-hidden="true" />
                {progress === null
                  ? "Starting the run"
                  : progress.phase === "loading"
                    ? `Loading ${shortTag(progress.lane.model)} (lane ${String(progress.laneNumber)} of ${String(progress.laneCount)})`
                    : `Answering on ${shortTag(progress.lane.model)} (lane ${String(progress.laneNumber)} of ${String(progress.laneCount)}) · ${String(progress.done)} of ${String(progress.total)} answers`}
                {" · "}
                <Term name="seed">seed</Term> {live.seed}
              </span>
            ) : shown === null ? (
              <span>
                Never run. Press Run all. Every lane answers every prompt on one pinned{" "}
                <Term name="seed">seed</Term>.
              </span>
            ) : (
              <span>
                {runLabel(benchmark, shown.id)} · <Term name="seed">seed</Term> {shown.seed}
                {shown.partial && " · partial"}
              </span>
            )}
            <span className="spacer" />
            {/* A count of what moved. Never a score: it says how many rows
                differ between lanes, not how many are good. */}
            <span className="btally">
              {parts.map((part) => (
                <span key={part.key} className={part.key}>
                  {part.label}
                </span>
              ))}
            </span>
          </div>
          <div className="benchmark">
            {rows.map((row) => (
              <PromptRow
                key={row.prompt.id}
                row={row}
                choices={choices}
                expanded={expanded.has(row.prompt.id)}
                onToggle={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(row.prompt.id)) next.delete(row.prompt.id);
                    else next.add(row.prompt.id);
                    return next;
                  })
                }
                onRemove={
                  onRemovePrompt === undefined ? null : () => onRemovePrompt(row.prompt.id)
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
