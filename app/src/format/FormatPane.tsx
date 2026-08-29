/**
 * The Format pane and its composer pill (docs/SPEC-round-two.md R2,
 * docs/mockup-proposals-2.html §02).
 *
 * A schema editor beside the chat, a `Schema · json · off` segmented
 * control, and a footer that says whether the schema is a schema. The logic
 * is next door in format.ts; this file is its display, the same split
 * tools/ToolsView.tsx has with tools/validate.ts.
 *
 * Two things it deliberately does not have:
 *
 * - **No "bake into Modelfile".** Ollama has no `PARAMETER format`, so there
 *   is nothing to bake; an affordance for it would write a line the server
 *   ignores and quietly stop constraining anything. The header says *this
 *   chat only* instead.
 * - **No parsed schema in state.** The text is the state (persisted on the
 *   session), and the schema is derived on every render — so a half-typed
 *   schema is kept exactly as typed rather than reverted to the last one
 *   that parsed.
 */
import "./FormatPane.css";
import type { FormatConfig, FormatMode } from "../chat/sessions";
import { formatLabel, parseSchema, propertyNames } from "./format";
import { PaneHelp, PaneHelpToggle } from "../help/PaneHelp";
import { useTourTarget } from "../tour/registry";

const MODES: { value: FormatMode; label: string; title: string }[] = [
  { value: "schema", label: "Schema", title: "Constrain decoding to the JSON Schema below" },
  { value: "json", label: "json", title: "Valid JSON, with no constraint on its shape" },
  { value: "off", label: "off", title: "Send no format field at all" },
];

/**
 * The note-bar pill beside Run controls. `dirty` whenever a constraint is in
 * force, because that is a thing about the next request the user should not
 * have to open a pane to discover.
 */
export function FormatPill({
  config,
  open,
  onToggle,
}: {
  config: FormatConfig | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const mode = config?.mode ?? "off";
  // R6 step 4's target. The pill only exists once there is a chat to hang it
  // off, so on an empty app the tour skips that step rather than pointing at
  // nothing.
  const tourRef = useTourTarget("format");
  return (
    <button
      type="button"
      ref={tourRef}
      className={`runpill${mode === "off" ? "" : " dirty"}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8 4H6a2 2 0 00-2 2v4l-2 2 2 2v4a2 2 0 002 2h2M16 4h2a2 2 0 012 2v4l2 2-2 2v4a2 2 0 01-2 2h-2" />
      </svg>
      Format · {formatLabel(config)}
    </button>
  );
}

export function FormatPane({
  config,
  onChange,
  onClose,
}: {
  config: FormatConfig;
  onChange: (next: FormatConfig) => void;
  onClose: () => void;
}) {
  // Recomputed on render, never stored — editing the schema re-judges every
  // reply already on screen (R2, and T3 before it).
  const parsed = parseSchema(config.text);
  const properties = propertyNames(parsed.schema);
  // The editor stays live in every mode: a schema you switched away from is
  // one you are coming back to, and clearing it on `off` would be the pane
  // throwing away the user's work to save a field.

  return (
    <section className="fmtpane" aria-label="Format">
      <div className="fmtpane-h">
        <b>Format</b>
        {/* Says the one thing about scope that matters: there is no
            PARAMETER format, so this cannot follow the model anywhere. */}
        <span className="hint">this chat only</span>
        <span className="spacer" />
        <span className="fmtseg" role="group" aria-label="Format mode">
          {MODES.map(({ value, label, title }) => (
            <button
              key={value}
              type="button"
              className={config.mode === value ? "on" : undefined}
              aria-pressed={config.mode === value}
              title={title}
              onClick={() => onChange({ ...config, mode: value })}
            >
              {label}
            </button>
          ))}
        </span>
        <PaneHelpToggle paneId="format" />
        <button type="button" className="fmtclose" aria-label="Close Format" onClick={onClose}>
          ✕
        </button>
      </div>

      <PaneHelp
        paneId="format"
        title="Format — force the reply into a shape"
        what="Ollama restricts what the model is allowed to say next so that the answer always fits the JSON Schema you write here."
        why="It isn’t an instruction the model can ignore and it isn’t a retry — a malformed reply is simply unreachable."
        steps={[
          "Write or paste a JSON Schema below.",
          "Switch to Schema — every reply now comes back in that shape.",
          "The card under each reply checks it field by field against your schema.",
        ]}
        note="This chat only — there’s no setting for it on a saved model, so there’s nothing to bake in."
      />

      <textarea
        className="fmtbox"
        aria-label="Response schema"
        spellCheck={false}
        value={config.text}
        onChange={(e) => onChange({ ...config, text: e.target.value })}
      />

      <div className="fmtfoot">
        {parsed.error !== null ? (
          // Local, and local is the point: the request is refused rather
          // than sent unconstrained, so this is the only place the failure
          // can be shown and the only place it can be fixed.
          <span className="bad" role="status">
            Doesn’t parse: {parsed.error}
          </span>
        ) : (
          <span className="ok" role="status">
            ✓ valid schema · {properties.length}{" "}
            {properties.length === 1 ? "property" : "properties"}
          </span>
        )}
        <span className="spacer" />
        <span className="fmtmode">
          {config.mode === "schema"
            ? "constrains decoding"
            : config.mode === "json"
              ? "json — valid JSON, any shape"
              : "off — no format sent"}
        </span>
      </div>

      {config.mode === "json" && (
        <p className="fmtnote" role="note">
          Replies will be valid JSON, but nothing holds them to this schema.
        </p>
      )}

      {/* Layer 1 — the empty state (R5). Nothing is turned on yet, so the
          pane explains itself before asking the user to discover the mode
          switch above on their own. */}
      {config.mode === "off" && (
        <div className="fmtempty">
          <span className="ef-ic">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 4H6a2 2 0 00-2 2v4l-2 2 2 2v4a2 2 0 002 2h2M16 4h2a2 2 0 012 2v4l2 2-2 2v4a2 2 0 01-2 2h-2" />
            </svg>
          </span>
          <h3>Nothing is constrained yet</h3>
          <p>
            Turn this on and Ollama restricts what the model can say next, so every reply fits
            the schema below instead of just being asked nicely to.
          </p>
          <ol className="ef-how">
            <li>
              <b>1</b>
              <span>Write or paste a JSON Schema below — a working example is already there.</span>
            </li>
            <li>
              <b>2</b>
              <span>Switch the mode above from off to Schema.</span>
            </li>
            <li>
              <b>3</b>
              <span>Chat as normal; the card under each reply checks it field by field.</span>
            </li>
          </ol>
        </div>
      )}
    </section>
  );
}
