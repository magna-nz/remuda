/**
 * Modelfile history — the third editor pane (SPEC-tuning.md T1,
 * docs/mockup-tuning.html `#t1`).
 *
 * Timeline left, unified diff right. The timeline lists this model's
 * snapshots newest-first; the diff is always "selected snapshot → working
 * copy", which is the question the view exists to answer: *what have I
 * changed since then?*
 *
 * Two rules the surface encodes:
 *
 *  - **Restore does not create.** "Restore this" loads the snapshot into the
 *    draft and switches to Raw. Nothing is built, nothing is reloaded.
 *  - **Drift is surfaced, not resolved.** When the working text hashes to
 *    nothing in the ring, an "edited outside Remuda" entry appears at the
 *    top rather than a stale snapshot being marked current.
 */
import { useState } from "react";
import "./HistoryView.css";
import { useRemuda } from "../ui/state";
import { hashText, kindLabel, type ModelfileSnapshot } from "./history";
import { diffLines, formatSummary, summarize } from "./diff";
import { relativeTime } from "../chat/sessions";

/** The summary line under a timeline entry: this snapshot vs the one before it. */
function entrySummary(snapshot: ModelfileSnapshot, older: ModelfileSnapshot | undefined): string {
  if (older === undefined) {
    return snapshot.kind === "saveas" ? "forked, first snapshot" : "first snapshot";
  }
  return formatSummary(summarize(older.rawText, snapshot.rawText));
}

export function HistoryView({ rawText }: { rawText: string }) {
  const { editorDraft, historyForTag, restoreSnapshot } = useRemuda();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const tag = editorDraft?.targetTag ?? null;
  const snapshots = historyForTag(tag);
  const workingHash = hashText(rawText);
  const current = snapshots.find((s) => hashText(s.rawText) === workingHash) ?? null;
  // Drift: the live text matches nothing in the ring. Only meaningful once
  // there is a ring to miss.
  const drifted = snapshots.length > 0 && current === null;

  const selected =
    snapshots.find((s) => s.id === selectedId) ?? current ?? snapshots[0] ?? null;

  if (tag === null) {
    return (
      <div className="histwrap empty">
        <p>
          This Modelfile has no target yet. <b>Save as…</b> names it, and that first save
          starts its history.
        </p>
      </div>
    );
  }
  if (snapshots.length === 0 || selected === null) {
    return (
      <div className="histwrap empty">
        <p>
          No snapshots for <code>{tag}</code> yet. Every <b>Save</b> and <b>Save as…</b> records
          one, and nothing else does.
        </p>
      </div>
    );
  }

  const lines = diffLines(selected.rawText, rawText);
  const unchanged = selected.rawText === rawText;

  return (
    <div className="histwrap">
      <div className="timeline" aria-label="Modelfile snapshots">
        {drifted && (
          <div className="hentry drift">
            <span className="hr1">
              <span className="hkind">Edited outside Remuda</span>
              <span className="htime">now</span>
            </span>
            <span className="hsum">
              <span className="hbadge drift">drift</span> working text is in no snapshot
            </span>
          </div>
        )}
        {snapshots.map((snapshot, i) => {
          const isCurrent = snapshot === current;
          const classes = ["hentry"];
          if (snapshot.id === selected.id) classes.push("on");
          if (isCurrent) classes.push("current");
          return (
            <button
              key={snapshot.id}
              type="button"
              className={classes.join(" ")}
              aria-pressed={snapshot.id === selected.id}
              onClick={() => setSelectedId(snapshot.id)}
            >
              <span className="hr1">
                <span className="hkind">{kindLabel(snapshot.kind)}</span>
                {isCurrent && <span className="hbadge">current</span>}
                <span className="htime">{relativeTime(snapshot.savedAt)}</span>
              </span>
              <span className="hsum">{entrySummary(snapshot, snapshots[i + 1])}</span>
            </button>
          );
        })}
      </div>
      <div className="diffpane">
        <div className="diffbar">
          <span className="dt">
            <b>{relativeTime(selected.savedAt)}</b> → working copy
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn xs"
            onClick={() => restoreSnapshot(selected.id)}
            title="Loads this text into the editor as an unsaved draft. It does not re-create the model."
          >
            Restore this
          </button>
        </div>
        <div className="diff">
          {unchanged ? (
            <div className="dl hunk">
              <span className="gut" />
              <span className="txt">no difference, this is the working text</span>
            </div>
          ) : (
            lines.map((line, i) => (
              <div className={`dl ${line.kind}`} key={i}>
                <span className="gut">{line.newLine ?? line.oldLine ?? ""}</span>
                <span className="txt">{line.text === "" ? " " : line.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
