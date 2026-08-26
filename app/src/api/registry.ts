/**
 * Registry probe (SPEC.md §5.5) — the live half of the Pull pane.
 *
 * The bundled catalog answers "what's out there?"; this answers "does the
 * exact thing I typed exist, and how big is it?" — including models
 * published after the catalog was generated.
 *
 * `registry.ollama.ai` sends no CORS headers, so this cannot be a `fetch`
 * from the webview; the request is made in Rust (`src-tauri/src/registry.rs`)
 * and reached through the global Tauri bridge. That keeps the frontend free
 * of `@tauri-apps/*` npm dependencies, and means we hand across a model
 * *name* rather than a URL.
 *
 * Progressive enhancement, deliberately: outside the desktop shell (a plain
 * `npm run dev` browser tab, or a test run) `probeModel` resolves to
 * `unavailable` and the UI simply omits the size line. Pulling still works —
 * Ollama reports a bad name itself.
 */

export interface ProbeFound {
  kind: "found";
  /** Total download size in bytes: every layer plus the config blob. */
  totalBytes: number;
  /** Normalised `namespace/model:tag`, e.g. `library/llama3.2:latest`. */
  resolved: string;
}

/** The registry answered, and there is no such model. A real answer. */
export interface ProbeMissing {
  kind: "missing";
  resolved: string;
}

/**
 * We could not find out — offline, timeout, 5xx, or a reference we don't
 * know how to probe. Distinct from `missing` on purpose: never tell someone
 * their model doesn't exist because their wifi dropped.
 */
export interface ProbeUnknown {
  kind: "unknown";
  reason: string;
}

/** No bridge available (browser dev, tests). The UI shows nothing at all. */
export interface ProbeUnavailable {
  kind: "unavailable";
}

export type ProbeResult = ProbeFound | ProbeMissing | ProbeUnknown | ProbeUnavailable;

/** Shape of the Rust `Probe` struct, serialised camelCase. */
interface WireProbe {
  exists: boolean;
  totalBytes: number;
  resolved: string;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriGlobal {
  core?: { invoke?: InvokeFn };
  /** Tauri 2 betas exposed invoke at the top level; tolerate both. */
  invoke?: InvokeFn;
}

/**
 * Resolve the bridge, or null when we're not running inside the shell.
 * Looked up per call rather than cached — `withGlobalTauri` is injected
 * before our bundle runs, but a cached null would be unrecoverable if that
 * ever stopped being true.
 */
function getInvoke(): InvokeFn | null {
  if (typeof window === "undefined") return null;
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return tauri?.core?.invoke ?? tauri?.invoke ?? null;
}

/** True when the probe can actually run — lets the UI skip the round trip. */
export function isProbeAvailable(): boolean {
  return getInvoke() !== null;
}

/**
 * Ask the registry about `[namespace/]model[:tag]`.
 *
 * Never rejects: every failure is a `ProbeResult` variant, because this is
 * a typing-time affordance and must not be able to break the input bar.
 */
export async function probeModel(reference: string): Promise<ProbeResult> {
  const invoke = getInvoke();
  if (invoke === null) return { kind: "unavailable" };
  if (reference.trim() === "") return { kind: "unknown", reason: "empty model name" };

  try {
    const probe = await invoke<WireProbe>("probe_model", { reference });
    return probe.exists
      ? { kind: "found", totalBytes: probe.totalBytes, resolved: probe.resolved }
      : { kind: "missing", resolved: probe.resolved };
  } catch (err) {
    // Rust returns Err(String); Tauri surfaces it as the rejection value.
    return { kind: "unknown", reason: typeof err === "string" ? err : String(err) };
  }
}
