/**
 * Host telemetry and process control — the frontend half of
 * `src-tauri/src/host.rs`.
 *
 * Reached through the global Tauri bridge (`withGlobalTauri`), the same way
 * `registry.ts` does, so the frontend stays free of `@tauri-apps/*` npm
 * dependencies. Opening external links goes through `tauri-plugin-opener`,
 * whose command is invoked by name; the plugin ships its own global API but we
 * do not need it, and the capability in `src-tauri/capabilities/default.json`
 * restricts it to `http`/`https`.
 *
 * Progressive enhancement, deliberately: outside the desktop shell (a plain
 * `npm run dev` browser tab, or a test run) `hostStats` resolves to `null` and
 * the UI renders without the telemetry row. The two *actions* reject instead —
 * silently doing nothing when someone clicks "Start Ollama" would be worse
 * than saying it is not available here.
 */

export interface HostStats {
  /** Physical RAM installed, in bytes. */
  memTotalBytes: number;
  /** Physical RAM in use, in bytes. */
  memUsedBytes: number;
  /**
   * Summed CPU% of every running `ollama` process.
   *
   * `null` means *unknown* — no Ollama process, or not enough samples yet.
   * It never stands in for zero: `0` is a real reading from an idle server,
   * and the UI may show it. Show nothing when this is `null`.
   */
  ollamaCpuPercent: number | null;
  /**
   * Always `null`. Apple Silicon exposes no supported GPU-utilisation API, so
   * Rust never fills this in. Declared so the contract does not change when
   * one appears — until then the UI must omit the row.
   */
  gpuPercent: number | null;
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

/** True when the desktop bridge is present — lets the UI skip the round trip. */
export function isHostAvailable(): boolean {
  return getInvoke() !== null;
}

/**
 * Rust returns `Err(String)` and Tauri surfaces it as the raw rejection value.
 * Wrap it so callers get a real `Error`, keeping the Rust text verbatim as the
 * message — for `startOllama` in particular that text ("No such file or
 * directory (os error 2)") is the whole point.
 */
function asError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" ? err : String(err));
}

function requireInvoke(): InvokeFn {
  const invoke = getInvoke();
  if (invoke === null) {
    throw new Error("this action is only available in the Remuda desktop app");
  }
  return invoke;
}

/**
 * Current host telemetry, or `null` when there is no desktop bridge.
 *
 * `null` is the "render without telemetry" signal — a browser tab or a test
 * run. A rejection is different: the bridge was there and the call failed.
 */
export async function hostStats(): Promise<HostStats | null> {
  const invoke = getInvoke();
  if (invoke === null) return null;

  try {
    return await invoke<HostStats>("host_stats");
  } catch (err) {
    throw asError(err);
  }
}

/**
 * Spawn `ollama serve` in the background.
 *
 * Resolves as soon as the process is spawned, not when the server is ready —
 * the health poll is what tells the UI it came up. Rejects with the spawn
 * error verbatim, which is how the user finds out Ollama is not on PATH.
 */
export async function startOllama(): Promise<void> {
  const invoke = requireInvoke();
  try {
    await invoke<null>("start_ollama");
  } catch (err) {
    throw asError(err);
  }
}

/**
 * Open `url` in the system browser rather than navigating the webview.
 *
 * Only `http` and `https` are permitted. The enforcing boundary is the scoped
 * `opener:allow-open-url` capability in Rust — this check is the earlier, more
 * legible half of it, so a bad link fails here with a clear message instead of
 * as an opaque ACL denial. Handing an arbitrary scheme to the platform opener
 * is an arbitrary-execution hazard; neither layer may relax this.
 */
export async function openExternal(url: string): Promise<void> {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    // No scheme at all, or otherwise unparseable. `new URL` is deliberate:
    // a prefix test on the string would be fooled by "https:evil" forms.
    throw new Error(`not an absolute URL: ${url}`);
  }
  if (scheme !== "http:" && scheme !== "https:") {
    throw new Error(`refusing to open ${scheme} URL: ${url}`);
  }

  const invoke = requireInvoke();
  try {
    await invoke<null>("plugin:opener|open_url", { url });
  } catch (err) {
    throw asError(err);
  }
}
