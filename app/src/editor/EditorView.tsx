/**
 * The Modelfile editor (SPEC.md §5.4, §8, §9; docs/mockup.html `.split`).
 *
 * Two columns: a friendly form on the left, the raw Modelfile on the right.
 * The raw text is the source of truth (SPEC §5.4) — form edits regenerate
 * their line(s) via the modelfile module's updaters and re-derive the raw
 * text from the resulting doc; raw edits re-parse into a new doc, which the
 * form re-reads from. Content the form doesn't model (comments, LICENSE,
 * ADAPTER, MESSAGE, advanced TEMPLATE, unrecognized PARAMETER keys) is never
 * touched by either path — it rides along in the doc and just gets called
 * out by the "advanced content preserved" note below.
 */
import { useEffect, useState } from "react";
import "./EditorView.css";
import { useRemuda } from "../ui/state";
import { SaveAsDialog } from "./SaveAsDialog";
import { passthroughKinds } from "./passthrough";
import {
  from,
  parameters,
  parseModelfile,
  serializeModelfile,
  setFrom,
  setParameter,
  setStops,
  setSystem,
  system,
  type ModelfileDoc,
} from "../modelfile";

const NUM_CTX_MIN = 2048;
const NUM_CTX_MAX = 131072;
const NUM_CTX_STEP = 2048;

/** parameters(doc) types every key as a string except `stop`, which is string[]. */
type ParamMap = Record<string, string | string[] | undefined>;

function paramString(params: ParamMap, key: string, fallback: string): string {
  const v = params[key];
  return typeof v === "string" ? v : fallback;
}

function paramStops(params: ParamMap): string[] {
  const v = params.stop;
  return Array.isArray(v) ? v : [];
}

export function EditorView() {
  const {
    editorDraft,
    editorLoading,
    editorError,
    groups,
    models,
    setEditorDoc,
    revertEditor,
    saveDraft,
    saving,
    saveError,
  } = useRemuda();

  const [rawText, setRawText] = useState("");
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [addingStop, setAddingStop] = useState(false);
  const [stopDraft, setStopDraft] = useState("");

  // Resync the raw pane from the doc only at "external" moments — opening a
  // model, opening a new one, reverting, or a completed save — all of which
  // replace `savedDoc`. Ordinary form edits update `rawText` directly (see
  // applyDocUpdate) so raw-text typing never gets clobbered mid-keystroke.
  useEffect(() => {
    if (editorDraft) setRawText(serializeModelfile(editorDraft.savedDoc));
  }, [editorDraft?.savedDoc]);

  if (editorLoading) {
    return (
      <div className="editorview-empty">
        <p>Loading Modelfile…</p>
      </div>
    );
  }
  if (editorError) {
    return (
      <div className="editorview-empty">
        <p role="alert">{editorError}</p>
      </div>
    );
  }
  if (!editorDraft) {
    return (
      <div className="editorview-empty">
        <p>Open a model's Modelfile from the pencil icon or the load pane's "+ New Modelfile".</p>
      </div>
    );
  }

  const doc = editorDraft.doc;

  function applyDocUpdate(updater: (doc: ModelfileDoc) => ModelfileDoc) {
    const newDoc = updater(doc);
    setEditorDoc(newDoc);
    setRawText(serializeModelfile(newDoc));
  }

  function handleRawChange(text: string) {
    setRawText(text);
    // Best-effort re-parse: an in-progress edit (an unterminated `"""`
    // block, say) just doesn't commit yet — never crash, never discard
    // what's on screen (SPEC §5.4's cardinal rule).
    try {
      const parsed = parseModelfile(text);
      setEditorDoc(parsed);
    } catch {
      // leave doc as-is; rawText already reflects what the user typed
    }
  }

  const params = parameters(doc) as ParamMap;
  const temperature = Number(paramString(params, "temperature", "0.7"));
  const topP = Number(paramString(params, "top_p", "0.9"));
  const numCtx = Number(paramString(params, "num_ctx", "8192"));
  const stops = paramStops(params);
  // FROM is required to save (toCreateRequest throws without one) but a
  // brand-new doc mid-edit could transiently lack it, so fall back to "".
  const baseTag = from(doc) ?? "";
  const kinds = passthroughKinds(rawText);

  const bases = Array.from(new Set([...groups.map((g) => g.base.tag), baseTag].filter(Boolean)));
  const baseModel = models.find((m) => m.tag === baseTag);
  const overNumCtx = baseModel?.contextLength != null && numCtx > baseModel.contextLength;

  function addStop() {
    const value = stopDraft.trim();
    if (value !== "") {
      applyDocUpdate((d) => setStops(d, [...stops, value]));
    }
    setStopDraft("");
    setAddingStop(false);
  }

  function removeStop(index: number) {
    applyDocUpdate((d) => setStops(d, stops.filter((_, i) => i !== index)));
  }

  return (
    <div className="editorview">
      <div className="split">
        <div className="col form">
          <div className="col-h">
            <span className="eyebrow">Settings</span>
            <span className="hint">friendly editor</span>
          </div>
          {/* Freeze all editing while a save is in flight — edits made
              mid-save would be overwritten when the saved doc lands. */}
          <fieldset className="form-scroll" disabled={saving}>
            <div className="field">
              <label htmlFor="ed-from">
                Base model — <span className="kwhint">FROM</span>
              </label>
              <select
                id="ed-from"
                className="input"
                value={baseTag}
                onChange={(e) => applyDocUpdate((d) => setFrom(d, e.target.value))}
              >
                {bases.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ed-system">
                System prompt — <span className="kwhint">SYSTEM</span>
              </label>
              <textarea
                id="ed-system"
                className="input"
                rows={4}
                value={system(doc) ?? ""}
                onChange={(e) => applyDocUpdate((d) => setSystem(d, e.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="ed-temp">Temperature</label>
              <div className="desc">Higher = more creative, lower = more focused.</div>
              <div className="slider-row">
                <input
                  id="ed-temp"
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) =>
                    applyDocUpdate((d) => setParameter(d, "temperature", e.target.value))
                  }
                />
                <span className="val">{temperature.toFixed(1)}</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="ed-topp">Top P</label>
              <div className="slider-row">
                <input
                  id="ed-topp"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={topP}
                  onChange={(e) => applyDocUpdate((d) => setParameter(d, "top_p", e.target.value))}
                />
                <span className="val">{topP.toFixed(2)}</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="ed-ctx">
                Context length — <span className="kwhint">num_ctx</span>
              </label>
              <div className="slider-row">
                <input
                  id="ed-ctx"
                  type="range"
                  min={NUM_CTX_MIN}
                  max={NUM_CTX_MAX}
                  step={NUM_CTX_STEP}
                  value={numCtx}
                  onChange={(e) => applyDocUpdate((d) => setParameter(d, "num_ctx", e.target.value))}
                />
                <span className="val">{numCtx.toLocaleString()}</span>
              </div>
              {overNumCtx && (
                <div className="warn-hint">
                  Exceeds {baseTag}'s trained context ({baseModel?.contextLength?.toLocaleString()}) — allowed, but may degrade quality.
                </div>
              )}
            </div>
            <div className="field">
              <label htmlFor="ed-stop">
                Stop sequences — <span className="kwhint">stop</span>
              </label>
              <div className="chips" id="ed-stop">
                {stops.map((s, i) => (
                  <span className="chip" key={`${s}-${i}`}>
                    {s}{" "}
                    <button type="button" onClick={() => removeStop(i)} aria-label={`Remove stop sequence ${s}`}>
                      ×
                    </button>
                  </span>
                ))}
                {addingStop ? (
                  <input
                    className="chip-input"
                    autoFocus
                    value={stopDraft}
                    aria-label="New stop sequence"
                    onChange={(e) => setStopDraft(e.target.value)}
                    onBlur={addStop}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addStop();
                      if (e.key === "Escape") {
                        setStopDraft("");
                        setAddingStop(false);
                      }
                    }}
                  />
                ) : (
                  <button type="button" className="chip add" onClick={() => setAddingStop(true)}>
                    + add
                  </button>
                )}
              </div>
            </div>
            {kinds.length > 0 && (
              <div className="advanced-note">
                Advanced content preserved (not shown here): {kinds.join(", ")}.
              </div>
            )}
          </fieldset>
        </div>
        <div className="col">
          <div className="col-h">
            <span className="eyebrow">Modelfile</span>
            <span className="hint">raw · edits sync both ways</span>
          </div>
          <div className="editor">
            <textarea
              className="rawtext"
              aria-label="Raw Modelfile"
              spellCheck={false}
              value={rawText}
              onChange={(e) => handleRawChange(e.target.value)}
              disabled={saving}
            />
          </div>
        </div>
      </div>
      <div className="savebar">
        <div className="saveline">
          <span className="note">
            On save, <b>Remuda</b> re-creates the model with <code>ollama create</code>, then{" "}
            <b>stops &amp; reloads</b> it so your chats use the new Modelfile.
          </span>
          <div className="spacer" />
          <button type="button" className="btn sm" onClick={revertEditor} disabled={!editorDraft.dirty || saving}>
            Revert
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => void saveDraft()}
            disabled={saving || !editorDraft.targetTag}
            title={editorDraft.targetTag ? undefined : "New Modelfile — use Save as… to name it"}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn sm primary" onClick={() => setSaveAsOpen(true)} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <path d="M17 21v-8H7v8M7 3v5h8" />
            </svg>
            Save as…
          </button>
        </div>
        {saveError !== null && (
          <div className="save-error" role="alert">
            {saveError}
          </div>
        )}
      </div>
      {saveAsOpen && (
        <SaveAsDialog
          baseTag={baseTag}
          onCancel={() => setSaveAsOpen(false)}
          onConfirm={(name) => {
            setSaveAsOpen(false);
            // A name that already carries a tag (support:v2) keeps it; only
            // bare names get the conventional :latest.
            void saveDraft(name.includes(":") ? name : `${name}:latest`);
          }}
        />
      )}
    </div>
  );
}
