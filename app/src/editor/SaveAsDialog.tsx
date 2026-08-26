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

export interface SaveAsDialogProps {
  baseTag: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}

export function SaveAsDialog({ baseTag, onCancel, onConfirm }: SaveAsDialogProps) {
  const [name, setName] = useState("");

  const trimmed = name.trim();
  const canCreate = trimmed !== "";

  function submit() {
    if (!canCreate) return;
    onConfirm(trimmed);
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
