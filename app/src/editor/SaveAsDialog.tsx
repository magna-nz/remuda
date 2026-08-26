/**
 * "Save as a new Modelfile" dialog (SPEC.md §5.4, §5.6; docs/mockup.html
 * `.dlg`). Asks directly for a name and a directory, then the caller runs
 * the same create → stop → reload flow as Save, targeting the new name.
 *
 * The directory field is display-only in this web build — SPEC §5.6's
 * default (`~/ollama/modelfiles/`), overridable once Settings persists a
 * real choice and a later Tauri layer can write to disk and browse for a
 * folder. Neither exists yet, so "Choose…" is disabled here.
 */
import { useState } from "react";
import "./SaveAsDialog.css";

const DEFAULT_MODELFILE_DIR = "~/ollama/modelfiles/";

/** Common re-quantisation levels `ollama create -q` accepts (SPEC §5.4, §9). */
const QUANT_LEVELS = ["q8_0", "q4_K_M", "q4_K_S"];

/** Sentinel for "don't pass -q at all" — see the `quantize` contract note below. */
const KEEP = "keep";

export interface SaveAsDialogProps {
  baseTag: string;
  /**
   * The base model's current quantisation (`Model.quantization`, e.g.
   * "Q4_K_M"), matched by tag — the same source the load pane already
   * displays. Null/undefined when it can't be determined; `Keep` still
   * works, it just can't name the level.
   */
  baseQuantization?: string | null;
  onCancel: () => void;
  /**
   * `quantize` is the exact value to forward to `saveDraft`/`/api/create`.
   * `undefined` means "Keep" was selected — no `-q` flag at all, not the
   * inherited level spelled out. Re-quantising to the level a model already
   * is wastes CPU and can degrade it further, so `Keep` must never resolve
   * to an explicit string.
   */
  onConfirm: (name: string, quantize?: string) => void;
}

export function SaveAsDialog({ baseTag, baseQuantization, onCancel, onConfirm }: SaveAsDialogProps) {
  const [name, setName] = useState("");
  const [quant, setQuant] = useState<string>(KEEP);

  const trimmed = name.trim();
  const canCreate = trimmed !== "";
  // Keep ⇒ undefined, always — see the onConfirm contract note above.
  const quantize = quant === KEEP ? undefined : quant;
  const keepLabel = baseQuantization ? `Keep · ${baseQuantization}` : "Keep";
  const previewName = trimmed !== "" ? trimmed : "<name>";
  const previewCommand = quantize
    ? `ollama create ${previewName} -q ${quantize}`
    : `ollama create ${previewName}`;

  function submit() {
    if (!canCreate) return;
    onConfirm(trimmed, quantize);
  }

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div className="dlg-back" onClick={onCancel} />
      <div className="dlg" role="dialog" aria-label="Save as a new Modelfile">
        <div className="dlg-h">
          <b>Save as a new Modelfile</b>
          <button type="button" className="iconbtn x" onClick={onCancel} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="dlg-b">
          <div className="field">
            <label htmlFor="sa-name">Name</label>
            <div className="namefield">
              <input
                id="sa-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
              <span className="tagsuffix">:latest</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="sa-quant">Quantisation</label>
            <div className="desc">Re-quantise while creating. Leave as <b>Keep</b> to inherit the base.</div>
            <div className="qgrid" id="sa-quant" role="group" aria-label="Quantisation">
              <button
                type="button"
                className={`q${quant === KEEP ? " on" : ""}`}
                aria-pressed={quant === KEEP}
                onClick={() => setQuant(KEEP)}
              >
                {keepLabel}
              </button>
              {QUANT_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={`q${quant === level ? " on" : ""}`}
                  aria-pressed={quant === level}
                  onClick={() => setQuant(level)}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="sa-path">Save Modelfile to</label>
            <div className="dlg-row">
              <div className="pathfield" id="sa-path">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
                <span>{DEFAULT_MODELFILE_DIR}</span>
              </div>
              <button type="button" className="btn sm" disabled title="Choosing a folder needs the desktop shell (not yet wired)">
                Choose…
              </button>
            </div>
          </div>
          <div className="dlg-note">
            Creates a new tuned model from <code>FROM {baseTag}</code>, writes the Modelfile to that folder, then loads it for your chats.
            <br />
            Runs <code>{previewCommand}</code>.
          </div>
        </div>
        <div className="dlg-f">
          <button type="button" className="btn sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn sm primary" onClick={submit} disabled={!canCreate}>
            Create &amp; load
          </button>
        </div>
      </div>
    </>
  );
}
