/**
 * The conformance card under one reply (docs/SPEC-round-two.md R2,
 * docs/mockup-proposals-2.html §02, `.conform`).
 *
 * The same shape as the tool-call card in tools/ToolsView.tsx, pointed at
 * the reply instead of the call — headline verdict, a per-property badge,
 * and the validator's own note when a property didn't hold.
 *
 * **Nothing here is stored.** The verdict is computed from the reply text
 * and the schema on every render (conform.ts), so fixing the schema
 * re-judges every reply already on screen.
 */
import "./ConformanceCard.css";
import { conformance } from "./conform";

function Tick() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function Warn() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 8v5M12 17h.01" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function ConformanceCard({
  text,
  schema,
  numPredict,
}: {
  /** The reply, verbatim. */
  text: string;
  /** The schema in force, or null in `json` mode (valid JSON, no shape). */
  schema: Record<string, unknown> | null;
  /** The chat's `num_predict` override, named when the reply was cut off. */
  numPredict?: number;
}) {
  const verdict = conformance(text, schema, numPredict);
  const good = verdict.status === "conforms";
  return (
    <div className="conform" role="group" aria-label="Conformance">
      <div className="conform-h">
        <span className={good ? "ok" : "bad"}>{good ? <Tick /> : <Warn />}</span>
        <span className={good ? "ok" : "bad"}>{verdict.headline}</span>
        <span className="spacer" />
        <span className="sname">{verdict.summary}</span>
      </div>
      {verdict.rows.map((row) => (
        <div className="frow" key={row.key}>
          <span className="fk">{row.key}</span>
          <span className="fv" title={row.detail ?? undefined}>
            {row.value}
          </span>
          <span className={`fb ${row.tone}`}>{row.badge}</span>
        </div>
      ))}
      {/* The notes the badges compress, spelled out — the tool-call card's
          `detail` strings, from the same validator. */}
      {verdict.rows
        .filter((row) => row.detail !== null && row.tone !== "ok")
        .map((row) => (
          <div className="fnote" key={`note-${row.key}`}>
            <span className="fk">{row.key}</span>
            <span>{row.detail}</span>
          </div>
        ))}
    </div>
  );
}
