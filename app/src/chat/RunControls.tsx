/**
 * Run controls — try a parameter without re-creating the model
 * (docs/mockup-proposals.html §04, SPEC.md §5.3).
 *
 * Ollama takes an `options` object on every /api/chat call, which is the API
 * behind `/set parameter` in `ollama run`. These overrides are **per session
 * and per request**: they never touch the saved Modelfile, which stays the
 * source of truth until the user deliberately bakes them in.
 *
 * `numCtx` is the odd one out and is labelled as such. It is load-time, not
 * sampling — changing it makes Ollama restart the runner with a different
 * memory footprint, which is at odds with SPEC §5.1's "loading is always the
 * explicit act". It stays here because trying a context length is exactly the
 * kind of question this popover exists to answer, but it warns first.
 */
import { useEffect, type ReactNode } from "react";
import "./RunControls.css";
import type { RunOptions } from "../api/types";

/** Every key the popover can override, in the order it presents them. */
const RUN_OPTION_KEYS = [
  "temperature",
  "topP",
  "topK",
  "repeatPenalty",
  "seed",
  "numPredict",
  "numCtx",
] as const satisfies readonly (keyof RunOptions)[];

/**
 * The keys this popover actually presents.
 *
 * Deliberately narrower than `keyof RunOptions`. A run option can exist
 * domain-wide without being a per-chat knob: `numGpu` is load-time, set in
 * the load pane because changing it forces a reload, so it has no slider
 * here and no sensible "inherited" starting position. Typing the maps below
 * against the presented list rather than against `keyof RunOptions` is what
 * stops every future load-time option from demanding a label and a fallback
 * for a control that will never render.
 */
type PresentedKey = (typeof RUN_OPTION_KEYS)[number];

const LABELS: Record<PresentedKey, string> = {
  temperature: "Temperature",
  topP: "Top P",
  topK: "Top K",
  repeatPenalty: "Repeat penalty",
  seed: "Seed",
  numPredict: "Max tokens",
  numCtx: "Context length",
};

/** Wire names, for the one-line note under a reply — what the request said. */
const WIRE_NAMES: Record<PresentedKey, string> = {
  temperature: "temperature",
  topP: "top_p",
  topK: "top_k",
  repeatPenalty: "repeat_penalty",
  seed: "seed",
  numPredict: "num_predict",
  numCtx: "num_ctx",
};

/** How many values this session overrides. Drives the pill's count and style. */
export function countOverrides(options: RunOptions | undefined): number {
  if (!options) return 0;
  return RUN_OPTION_KEYS.filter((k) => options[k] !== undefined).length;
}

/** "temperature 0.9 · seed 42" — the note under a reply names what it ran with. */
export function describeOverrides(options: RunOptions | undefined): string {
  if (!options) return "";
  return RUN_OPTION_KEYS.filter((k) => options[k] !== undefined)
    .map((k) => `${WIRE_NAMES[k]} ${options[k]}`)
    .join(" · ");
}

/** Space-grouped digits, as in the mockup: 26 624 rather than 26,624. */
export function groupDigits(value: number): string {
  return value.toLocaleString("en-US").replace(/,/g, " ");
}

/**
 * What a knob shows before it is overridden. Only `numCtx` has a value we
 * actually know — the model's trained context, from /api/show. The rest are
 * Ollama's own defaults, shown as a starting position for the slider and
 * labelled "inherited", never "Modelfile": Remuda hasn't read the Modelfile
 * here and won't claim a number came from it.
 */
const FALLBACKS = {
  temperature: 0.8,
  topP: 0.9,
  topK: 40,
  repeatPenalty: 1.1,
  seed: 0,
  numPredict: -1,
  numCtx: 4096,
} as const satisfies Record<PresentedKey, number>;

const DEFAULT_CTX_MAX = 131_072;

/**
 * Names one mounted instance apart from another (SPEC-tuning T2).
 *
 * Two popovers open at once — one per A/B lane — collide on both halves of
 * an addressable control: `id="run-temperature"` is duplicated in the DOM,
 * and so is the accessible name "Temperature", which leaves
 * `getByLabelText("Temperature")` ambiguous and a `<label htmlFor>` click
 * landing on whichever input the browser resolves first.
 *
 * `scope` fixes both, and only when it is given: an unscoped instance emits
 * byte-for-byte what it always did, so the single-lane surface and its tests
 * are untouched. The *visible* label stays "Temperature" either way — the
 * lane is already named an inch away by the popover's own header, and
 * repeating it on every knob would be noise.
 */
function scopedId(scope: string | undefined, optionKey: PresentedKey): string {
  if (scope === undefined) return `run-${optionKey}`;
  return `run-${scope.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${optionKey}`;
}

/** The accessible name for a control inside a scoped instance; undefined
 *  outside one, where the visible label is already the name. */
function scopedName(scope: string | undefined, label: string): string | undefined {
  return scope === undefined ? undefined : `${scope} ${label}`;
}

function KnobHeader({
  label,
  ariaLabel,
  id,
  overridden,
  inheritedNote,
  onReset,
}: {
  label: string;
  ariaLabel: string | undefined;
  id: string;
  overridden: boolean;
  inheritedNote: string;
  onReset: () => void;
}) {
  const name = ariaLabel ?? label;
  return (
    <div className="kh">
      <label htmlFor={id}>{label}</label>
      {overridden ? (
        <button
          type="button"
          className="src over"
          aria-label={`Reset ${name}`}
          title={`Reset ${name} to the inherited value`}
          onClick={onReset}
        >
          overridden · reset
        </button>
      ) : (
        <span className="src">{inheritedNote}</span>
      )}
    </div>
  );
}

function SliderKnob(props: {
  optionKey: PresentedKey;
  scope: string | undefined;
  min: number;
  max: number;
  step: number;
  value: number;
  overridden: boolean;
  inheritedNote: string;
  format: (value: number) => string;
  onSet: (value: number) => void;
  onReset: () => void;
  children?: ReactNode;
}) {
  const id = scopedId(props.scope, props.optionKey);
  const ariaLabel = scopedName(props.scope, LABELS[props.optionKey]);
  return (
    <div className="knob">
      <KnobHeader
        label={LABELS[props.optionKey]}
        ariaLabel={ariaLabel}
        id={id}
        overridden={props.overridden}
        inheritedNote={props.inheritedNote}
        onReset={props.onReset}
      />
      <div className="row">
        <input
          id={id}
          aria-label={ariaLabel}
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          onChange={(e) => props.onSet(Number(e.target.value))}
        />
        <span className={`val${props.overridden ? " over" : ""}`}>{props.format(props.value)}</span>
      </div>
      {props.children}
    </div>
  );
}

function NumberKnob(props: {
  optionKey: PresentedKey;
  scope: string | undefined;
  value: number | undefined;
  placeholder: string;
  overridden: boolean;
  inheritedNote: string;
  hint: string;
  onSet: (value: number | undefined) => void;
  onReset: () => void;
}) {
  const id = scopedId(props.scope, props.optionKey);
  const ariaLabel = scopedName(props.scope, LABELS[props.optionKey]);
  return (
    <div className="knob">
      <KnobHeader
        label={LABELS[props.optionKey]}
        ariaLabel={ariaLabel}
        id={id}
        overridden={props.overridden}
        inheritedNote={props.inheritedNote}
        onReset={props.onReset}
      />
      <input
        id={id}
        aria-label={ariaLabel}
        className="input"
        type="number"
        value={props.value === undefined ? "" : props.value}
        placeholder={props.placeholder}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") {
            props.onSet(undefined);
            return;
          }
          const parsed = Number(raw);
          props.onSet(Number.isFinite(parsed) ? parsed : undefined);
        }}
      />
      <div className="hint">{props.hint}</div>
    </div>
  );
}

export interface RunControlsProps {
  /** The session's current overrides; every absent key is inherited. */
  options: RunOptions;
  /** The model's trained context window (/api/show); null when unknown.
   *  Sets the slider's range and the "inherited" label. */
  modelContextLength: number | null;
  /**
   * The context the runner was actually started with (/api/ps); null when
   * nothing is resident. This — not the trained ceiling — is what decides
   * whether the next request reloads the model, so it is the only thing the
   * reload warning may compare against. A model can sit well below its
   * ceiling because its Modelfile pins `num_ctx`.
   */
  runningContextLength: number | null;
  /** Replaces the whole override set — the caller persists it per session. */
  onChange: (options: RunOptions) => void;
  onClose: () => void;
  /** Hand the winning values to the Modelfile editor. */
  onBake: () => void;
  /**
   * Names this instance when more than one is mounted — "Lane A" / "Lane B"
   * for an A/B run (SPEC-tuning T2). Absent is the single-lane popover, which
   * renders exactly as it always has; see `scopedId` above for why both the
   * DOM ids and the accessible names have to move together.
   */
  scope?: string;
}

export function RunControls({
  options,
  modelContextLength,
  runningContextLength,
  onChange,
  onClose,
  onBake,
  scope,
}: RunControlsProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const set = (key: keyof RunOptions, value: number | undefined) => {
    const next: RunOptions = { ...options };
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  };

  const inheritedCtx = modelContextLength;
  const ctxValue = options.numCtx ?? inheritedCtx ?? FALLBACKS.numCtx;
  // Load-time, not sampling: warn as soon as the request would ask for a
  // different context than the runner already has. Measured against the
  // RUNNING context, never the trained ceiling — with nothing resident there
  // is no reload to warn about, only a first load at the requested size.
  const ctxWillReload =
    options.numCtx !== undefined &&
    runningContextLength !== null &&
    options.numCtx !== runningContextLength;
  const ctxMax = Math.max(inheritedCtx ?? 0, ctxValue, DEFAULT_CTX_MAX);

  const overrideCount = countOverrides(options);
  const dialogName = scope === undefined ? "Run controls" : `Run controls · ${scope}`;

  return (
    <div className={`runpop${scope === undefined ? "" : " scoped"}`} role="dialog" aria-label={dialogName}>
      <div className="runpop-h">
        <b>Run controls</b>
        <span className="scope">{scope === undefined ? "this chat only" : `${scope} only`}</span>
        <button
          type="button"
          className="btn ghost sm x"
          aria-label={
            scope === undefined ? "Close run controls" : `Close run controls · ${scope}`
          }
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="runpop-b">
        <SliderKnob
          optionKey="temperature"
          scope={scope}
          min={0}
          max={2}
          step={0.05}
          value={options.temperature ?? FALLBACKS.temperature}
          overridden={options.temperature !== undefined}
          inheritedNote="inherited"
          format={(v) => v.toFixed(2)}
          onSet={(v) => set("temperature", v)}
          onReset={() => set("temperature", undefined)}
        />
        <SliderKnob
          optionKey="topP"
          scope={scope}
          min={0}
          max={1}
          step={0.01}
          value={options.topP ?? FALLBACKS.topP}
          overridden={options.topP !== undefined}
          inheritedNote="inherited"
          format={(v) => v.toFixed(2)}
          onSet={(v) => set("topP", v)}
          onReset={() => set("topP", undefined)}
        />
        <SliderKnob
          optionKey="topK"
          scope={scope}
          min={1}
          max={200}
          step={1}
          value={options.topK ?? FALLBACKS.topK}
          overridden={options.topK !== undefined}
          inheritedNote="inherited"
          format={(v) => String(Math.round(v))}
          onSet={(v) => set("topK", v)}
          onReset={() => set("topK", undefined)}
        />
        <SliderKnob
          optionKey="repeatPenalty"
          scope={scope}
          min={0.5}
          max={2}
          step={0.01}
          value={options.repeatPenalty ?? FALLBACKS.repeatPenalty}
          overridden={options.repeatPenalty !== undefined}
          inheritedNote="inherited"
          format={(v) => v.toFixed(2)}
          onSet={(v) => set("repeatPenalty", v)}
          onReset={() => set("repeatPenalty", undefined)}
        />
        <NumberKnob
          optionKey="seed"
          scope={scope}
          value={options.seed}
          placeholder="inherited"
          overridden={options.seed !== undefined}
          inheritedNote="inherited"
          hint="A fixed seed makes replies reproducible."
          onSet={(v) => set("seed", v)}
          onReset={() => set("seed", undefined)}
        />
        <NumberKnob
          optionKey="numPredict"
          scope={scope}
          value={options.numPredict}
          placeholder="inherited"
          overridden={options.numPredict !== undefined}
          inheritedNote="inherited"
          hint="Tokens to generate before stopping. −1 is unlimited."
          onSet={(v) => set("numPredict", v)}
          onReset={() => set("numPredict", undefined)}
        />
        <SliderKnob
          optionKey="numCtx"
          scope={scope}
          min={512}
          max={ctxMax}
          step={512}
          value={ctxValue}
          overridden={options.numCtx !== undefined}
          inheritedNote={
            inheritedCtx === null ? "inherited" : `inherited · ${groupDigits(inheritedCtx)}`
          }
          format={groupDigits}
          onSet={(v) => set("numCtx", v)}
          onReset={() => set("numCtx", undefined)}
        >
          {ctxWillReload && (
            <div className="ctx-warn" role="alert">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              </svg>
              <div>
                <b>Context length reloads the model.</b> This isn’t a sampling knob — the next
                message restarts the runner with a different memory footprint, and the model is
                briefly unavailable.
              </div>
            </div>
          )}
        </SliderKnob>
      </div>

      <div className="runpop-f">
        <button
          type="button"
          className="btn ghost sm"
          aria-label={scopedName(scope, "Reset to Modelfile")}
          disabled={overrideCount === 0}
          onClick={() => onChange({})}
        >
          Reset to Modelfile
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn sm primary"
          aria-label={scopedName(scope, "Bake into Modelfile…")}
          onClick={onBake}
        >
          Bake into Modelfile…
        </button>
      </div>
    </div>
  );
}

/** The composer pill that opens the popover; accented once anything is set. */
export function RunControlsPill({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`runpill${count > 0 ? " dirty" : ""}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
        <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h10M18 18h2" />
        <circle cx="16" cy="6" r="2" />
        <circle cx="8" cy="12" r="2" />
        <circle cx="16" cy="18" r="2" />
      </svg>
      {count > 0 ? `Run controls · ${count} overridden` : "Run controls"}
    </button>
  );
}
