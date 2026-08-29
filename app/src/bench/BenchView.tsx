/**
 * The run table (docs/SPEC-tuning.md T5, docs/SPEC-round-two.md R4;
 * docs/mockup-proposals-2.html §01 `.benchhead` / `.runbar` / `.brow`).
 *
 * One row per prompt, **collapsed by default and sorted changed-first**,
 * because the point of a bench is that you only read the ones that moved.
 * Expanding a row puts the previous answer beside the current one,
 * word-diffed by bench/words.ts — which is editor/diff.ts with words for
 * lines, not a second diff.
 *
 * The header names the run, the T1 Modelfile snapshot it ran against, and
 * the seed. That line is what makes the Modelfile history and the results
 * one artifact instead of two.
 *
 * The rule this whole surface is built around: **same / changed is a diff,
 * not a verdict.** No row is scored, no row is called better, and the table
 * is never ordered by anything but "did the text move".
 */
import { useMemo, useState } from "react";
import "./BenchView.css";
import { BenchEmpty } from "./BenchEmpty";
import {
  latestRun,
  previousRun,
  runLabel,
  type Bench,
  type BenchResult,
  type BenchRun,
} from "./benches";
import {
  ROW_BADGE,
  buildRows,
  formatDuration,
  rowSnippet,
  tally,
  tallyParts,
  type BenchRow,
} from "./rows";
import { diffWords, newSide, oldSide, type WordChunk } from "./words";
import { shortTag } from "../chat/sessions";
import { useRemuda } from "../ui/state";
import type { ModelfileSnapshot } from "../editor/history";

/** "14:22" — the run bar's time, in the user's own locale. */
function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * "terse-v2 @ 14:22" — the snapshot a run ran against.
 *
 * A run whose snapshot has since been evicted from the T1 ring says so,
 * rather than borrowing the current Modelfile's name: the point of the line
 * is to identify the text that produced these answers, and a wrong name is
 * worse than an admitted gap.
 */
function snapshotLabel(snapshotId: string | null, history: ModelfileSnapshot[]): string {
  if (snapshotId === null) return "no saved Modelfile";
  const snapshot = history.find((s) => s.id === snapshotId);
  if (snapshot === undefined) return "a Modelfile no longer in history";
  return `${shortTag(snapshot.tag)} @ ${clockTime(snapshot.savedAt)}`;
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
  now,
  result,
  chunks,
}: {
  head: string;
  now?: boolean;
  result: BenchResult | null;
  chunks: WordChunk[] | null;
}) {
  return (
    <div className="bcol">
      <div className="bcol-h">{now === true ? <b className="now">{head}</b> : <b>{head}</b>}</div>
      <div className="bcol-b">
        {result === null ? (
          <span className="bcol-none">no answer</span>
        ) : result.error !== undefined ? (
          // An errored row is a real result and keeps its cause verbatim
          // (R4) — a context-length failure is exactly what a bench is for.
          <span className="bcol-err">{result.error}</span>
        ) : chunks !== null ? (
          <Chunks chunks={chunks} />
        ) : (
          result.content
        )}
      </div>
      {result?.stats !== undefined && (
        <div className="bfoot">
          <span>{result.stats.evalCount} tok</span>
          {result.stats.tokPerSec !== null && <span>{result.stats.tokPerSec} tok/s</span>}
        </div>
      )}
    </div>
  );
}

function Row({
  row,
  currentHead,
  previousHead,
  expanded,
  onToggle,
  onRemove,
}: {
  row: BenchRow;
  currentHead: string;
  previousHead: string | null;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  // Diffed only when both sides are real answers. An error has no words to
  // align, and there is nothing honest to diff a first run against.
  const chunks = useMemo(() => {
    if (row.previous === null || row.current === null) return null;
    if (row.previous.error !== undefined || row.current.error !== undefined) return null;
    return diffWords(row.previous.content, row.current.content);
  }, [row.previous, row.current]);

  const number = String(row.number).padStart(2, "0");

  return (
    <div className="brow">
      <button type="button" className="brow-h" aria-expanded={expanded} onClick={onToggle}>
        <span className="brow-n">{number}</span>
        <span className="brow-p">
          {row.prompt.text}
          <span className={row.state === "error" ? "sn err" : "sn"}>{rowSnippet(row)}</span>
        </span>
        <span className={`bbadge ${row.state}`}>{ROW_BADGE[row.state]}</span>
        <span className="brow-t">{formatDuration(row.current)}</span>
      </button>
      <button
        type="button"
        className="brow-x"
        title="Remove this prompt"
        aria-label={`Remove prompt ${row.number}`}
        onClick={onRemove}
      >
        ×
      </button>
      {expanded && (
        <div className="brow-b">
          {previousHead !== null && (
            <Column
              head={previousHead}
              result={row.previous}
              chunks={chunks === null ? null : oldSide(chunks)}
            />
          )}
          <Column
            head={currentHead}
            now
            result={row.current}
            chunks={chunks === null ? null : newSide(chunks)}
          />
        </div>
      )}
    </div>
  );
}

export function BenchView() {
  const {
    benches,
    activeBenchId,
    benchProgress,
    modelfileHistory,
    startBenchRun,
    cancelBenchRun,
    removeBenchPrompt,
    renameBench,
  } = useRemuda();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const bench: Bench | undefined = benches.find((b) => b.id === activeBenchId);
  const running = benchProgress !== null && benchProgress.benchId === activeBenchId;

  const live: BenchRun | null =
    bench !== undefined && running && benchProgress !== null
      ? {
          id: "live",
          ranAt: new Date().toISOString(),
          snapshotId: null,
          seed: benchProgress.seed,
          partial: true,
          results: benchProgress.results,
        }
      : null;

  const rows = useMemo(() => {
    if (bench === undefined) return [];
    if (live !== null) return buildRows(bench, live, latestRun(bench));
    // `selectedRunId` names a run the user picked; null means the newest.
    const chosen =
      selectedRunId === null
        ? latestRun(bench)
        : (bench.runs.find((r) => r.id === selectedRunId) ?? latestRun(bench));
    const before = chosen === null ? null : previousRun(bench, chosen.id);
    return buildRows(bench, chosen, before);
    // `live` is rebuilt on every progress tick, which is exactly when the
    // table should refresh.
  }, [bench, live, selectedRunId]);

  if (bench === undefined) {
    return (
      <div className="benchview">
        <p className="empty-note">No bench is open. Pick one from the rail, or make one.</p>
      </div>
    );
  }

  const chosen: BenchRun | null =
    live ??
    (selectedRunId === null
      ? latestRun(bench)
      : (bench.runs.find((r) => r.id === selectedRunId) ?? latestRun(bench)));
  const before = chosen === null || live !== null ? latestRun(bench) : previousRun(bench, chosen.id);
  const counts = tally(rows);
  const parts = tallyParts(counts);

  const currentHead =
    live !== null ? "this run" : chosen === null ? "" : runLabel(bench, chosen.id);
  const previousHead = before === null ? null : runLabel(bench, before.id);

  return (
    <div className="benchview">
      <div className="benchhead">
        <b>{bench.name}</b>
        <button
          type="button"
          className="benchrename"
          title="Rename this bench"
          aria-label={`Rename bench ${bench.name}`}
          onClick={() => {
            const name = window.prompt("Name this bench", bench.name);
            if (name !== null) renameBench(bench.id, name);
          }}
        >
          ✎
        </button>
        <span className="bmeta">
          {bench.prompts.length === 0
            ? "empty"
            : `${bench.prompts.length} ${bench.prompts.length === 1 ? "prompt" : "prompts"}`}{" "}
          · {bench.model}
        </span>
        <span className="spacer" />
        {bench.runs.length > 0 && live === null && (
          <select
            className="runsel"
            aria-label="Run to show"
            value={chosen?.id ?? ""}
            onChange={(e) => setSelectedRunId(e.target.value)}
          >
            {bench.runs.map((run) => (
              <option key={run.id} value={run.id}>
                {`${runLabel(bench, run.id)} · ${clockTime(run.ranAt)}${run.partial ? " · partial" : ""}`}
              </option>
            ))}
          </select>
        )}
        {running ? (
          <button type="button" className="btn sm" onClick={cancelBenchRun}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn sm primary"
            disabled={bench.prompts.length === 0}
            title={bench.prompts.length === 0 ? "Add a prompt first" : undefined}
            onClick={() => void startBenchRun(bench.id)}
          >
            Run all
          </button>
        )}
      </div>

      {bench.prompts.length === 0 ? (
        <BenchEmpty />
      ) : (
        <>
          <div className="runbar">
            {chosen === null ? (
              <span>Never run. Press Run all — every prompt goes on one pinned seed.</span>
            ) : (
              <span>
                {live !== null
                  ? `running ${benchProgress?.done ?? 0} of ${benchProgress?.total ?? 0}`
                  : currentHead}{" "}
                · against{" "}
                <span className="against">{snapshotLabel(chosen.snapshotId, modelfileHistory)}</span>{" "}
                · seed {chosen.seed}
                {chosen.partial && live === null && " · partial"}
              </span>
            )}
            <span className="spacer" />
            {/* A count of what moved. Never a score: the strip says how many
                answers differ, not how many are good. */}
            <span className="btally">
              {parts.map((part) => (
                <span key={part.key} className={part.key}>
                  {part.label}
                </span>
              ))}
            </span>
          </div>
          <div className="bench">
            {rows.map((row) => (
              <Row
                key={row.prompt.id}
                row={row}
                currentHead={currentHead}
                previousHead={row.previous === null ? null : previousHead}
                expanded={expanded.has(row.prompt.id)}
                onToggle={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (!next.delete(row.prompt.id)) next.add(row.prompt.id);
                    return next;
                  })
                }
                onRemove={() => removeBenchPrompt(bench.id, row.prompt.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
