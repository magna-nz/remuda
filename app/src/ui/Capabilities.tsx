/**
 * Capability chips (SPEC.md §5.1; mockup-proposals.html §02), shared between
 * the Pull catalog (registry-reported capabilities) and the load pane
 * (installed models' `capabilities`, from POST /api/show).
 *
 * `capabilities` is deliberately `string[]` and not a closed union (see
 * api/types.ts) — Ollama adds capabilities over time, so an unrecognised
 * string must render, not crash or vanish. Known capabilities get an accent
 * colour; anything else falls back to the neutral chip style.
 *
 * `completion` never gets its own chip — it's the default, unremarkable
 * capability. Its *absence* is what's worth flagging: a model whose
 * capabilities lack it can't hold a chat, so its remaining capabilities
 * (typically just `embedding`) are labelled "· no chat" rather than left to
 * imply something the model can't do.
 */
import "./Capabilities.css";

export interface CapabilitiesProps {
  /** Capability strings as reported by Ollama, e.g. ["tools","thinking"]. */
  capabilities: string[];
  /** Extra class on the wrapping element, for callers that need spacing overrides. */
  className?: string;
}

/** Capabilities with a dedicated accent colour (see Capabilities.css). */
const ACCENTED = new Set(["tools", "thinking", "vision", "embedding"]);

export function Capabilities({ capabilities, className }: CapabilitiesProps) {
  const hasCompletion = capabilities.includes("completion");
  const visible = capabilities.filter((c) => c !== "completion");
  if (visible.length === 0) return null;

  return (
    <div className={className ? `caps ${className}` : "caps"}>
      {visible.map((c) => (
        <span key={c} className={ACCENTED.has(c) ? `cap cap-${c}` : "cap"}>
          {c === "embedding" && !hasCompletion ? "embedding · no chat" : c}
        </span>
      ))}
    </div>
  );
}
