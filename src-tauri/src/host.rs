//! Host telemetry and Ollama process control.
//!
//! The status bar wants to answer two questions a webview cannot: how much
//! memory this machine has left, and whether `ollama` is actually burning
//! CPU right now. Both come from `sysinfo` — a safe, portable crate — rather
//! than hand-rolled mach/libproc FFI, so this stays reviewable.
//!
//! The governing rule for every optional field here: `None` means *we could
//! not find out*, never *the value is zero*. The UI omits a row rather than
//! showing a confident 0%, because a false 0% is worse than a missing one.

use std::ffi::OsStr;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, MINIMUM_CPU_UPDATE_INTERVAL};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStats {
    /// Physical RAM installed, in bytes.
    pub mem_total_bytes: u64,
    /// Physical RAM in use, in bytes.
    pub mem_used_bytes: u64,
    /// Summed CPU% of every running `ollama` process, or `None` when no such
    /// process exists — or when we do not yet have two samples to diff.
    /// Never `Some(0.0)` as a stand-in for "don't know".
    pub ollama_cpu_percent: Option<f32>,
    /// Deliberately unimplemented: always `None`.
    ///
    /// Apple Silicon exposes no supported per-process or system GPU-utilisation
    /// API. `powermetrics` needs root, and the private frameworks that carry
    /// the number are not something a notarised app should bind. The field is
    /// declared so the UI contract does not have to change when a supported
    /// route appears — pending a spike, it stays `None`.
    pub gpu_percent: Option<f32>,
}

/// Does this process name identify the Ollama binary?
///
/// Matched on the name alone, case-insensitively, tolerating a `.exe` suffix.
/// The server and the model runner both run as argv[0] `ollama` (the runner is
/// spawned as `ollama runner ...`), so an exact match catches both; their usage
/// is summed by the caller. Deliberately exact rather than a substring test, so
/// an unrelated `ollama-exporter` sitting on the box is not counted as ours.
fn is_ollama_process(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let stem = name.strip_suffix(".exe").unwrap_or(name);
    stem.eq_ignore_ascii_case("ollama")
}

/// Persistent sampling state.
///
/// `sysinfo` derives CPU% from the delta between two refreshes, which means a
/// single-shot reading is always 0.0 and always a lie. Rather than blocking the
/// command for `MINIMUM_CPU_UPDATE_INTERVAL` — these commands are synchronous
/// and run on the main thread, so a sleep there would stutter the window — the
/// `System` is kept alive between calls and the delta is taken against the
/// *previous* call. The frontend polls on a timer, so from the second poll
/// onwards the number is real. Before that it is `None`.
struct Sampler {
    sys: System,
    /// When the process list was last refreshed. `None` until the first call.
    last_refresh: Option<Instant>,
    /// Whether an `ollama` process was present at the previous refresh. Without
    /// this, a process that appeared *since* the last refresh would report 0.0
    /// (it has no earlier sample either) and we would publish a false zero.
    saw_ollama: bool,
    /// Last computed reading, reused when polled faster than `sysinfo` can give
    /// a meaningful answer.
    last_cpu: Option<f32>,
}

impl Sampler {
    fn new() -> Self {
        Self {
            sys: System::new(),
            last_refresh: None,
            saw_ollama: false,
            last_cpu: None,
        }
    }

    fn sample(&mut self) -> HostStats {
        self.sys.refresh_memory();

        let now = Instant::now();
        // Refreshing sooner than the minimum interval would reset the sampling
        // window and starve a fast poller of any reading at all, so skip it and
        // reuse the last answer instead.
        let due = match self.last_refresh {
            None => true,
            Some(previous) => now.duration_since(previous) >= MINIMUM_CPU_UPDATE_INTERVAL,
        };

        if due {
            self.sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_cpu(),
            );

            let mut total = 0.0_f32;
            let mut found = false;
            for process in self.sys.processes().values() {
                if is_ollama_process(process.name()) {
                    found = true;
                    total += process.cpu_usage();
                }
            }

            let have_prior_sample = self.last_refresh.is_some() && self.saw_ollama;
            self.last_cpu = if found && have_prior_sample {
                Some(total)
            } else {
                // Either there is no Ollama, or this is the first refresh that
                // has seen one and there is nothing to diff against yet.
                None
            };
            self.saw_ollama = found;
            self.last_refresh = Some(now);
        }

        HostStats {
            mem_total_bytes: self.sys.total_memory(),
            mem_used_bytes: self.sys.used_memory(),
            ollama_cpu_percent: self.last_cpu,
            gpu_percent: None,
        }
    }
}

fn sampler() -> &'static Mutex<Sampler> {
    static SAMPLER: OnceLock<Mutex<Sampler>> = OnceLock::new();
    SAMPLER.get_or_init(|| Mutex::new(Sampler::new()))
}

/// Current host telemetry.
///
/// Returns `Result` for contract stability even though the present
/// implementation cannot fail — the frontend already handles a rejection, and
/// a future field (GPU) may well need to report one.
#[tauri::command]
pub fn host_stats() -> Result<HostStats, String> {
    // A panic in another caller poisoned the lock; the sampler holds no
    // invariant worth abandoning the reading over, so recover and carry on.
    let mut sampler = sampler().lock().unwrap_or_else(|e| e.into_inner());
    Ok(sampler.sample())
}

/// Start `ollama serve` in the background.
///
/// Returns as soon as the process is spawned — the frontend already polls
/// `/api/version` on a timer, so waiting for readiness here would only block
/// the UI for the same information.
///
/// The spawn error is returned verbatim. "No such file or directory (os error
/// 2)" tells the user Ollama is not on PATH, which is exactly what they need
/// to know; a friendlier "couldn't start Ollama" would not.
/// Where `ollama` actually lives, when PATH won't tell us.
///
/// A bundle launched from Finder inherits launchd's minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) — not the shell's — so a Homebrew
/// install at `/opt/homebrew/bin/ollama` is invisible to a bare
/// `Command::new("ollama")`. Bare name first, so a PATH that *does* carry it
/// (development, or an unusual install) still wins.
const OLLAMA_FALLBACK_PATHS: &[&str] = &[
    "/opt/homebrew/bin/ollama",
    "/usr/local/bin/ollama",
    "/usr/bin/ollama",
];

fn ollama_program() -> String {
    if Command::new("ollama")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
    {
        return "ollama".to_string();
    }
    for candidate in OLLAMA_FALLBACK_PATHS {
        if std::path::Path::new(candidate).exists() {
            return (*candidate).to_string();
        }
    }
    // Nothing found: fall back to the bare name so the spawn error the user
    // sees is the real "No such file or directory (os error 2)" rather than a
    // message we invented about a path we guessed.
    "ollama".to_string()
}

#[tauri::command]
pub fn start_ollama() -> Result<(), String> {
    let mut command = Command::new(ollama_program());
    command
        .arg("serve")
        // Nothing is reading this process's pipes; leaving them connected would
        // eventually block the server on a full buffer.
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Its own process group, so a signal aimed at Remuda (or at the terminal
    // that launched it during development) does not take the server down too.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    // The `Child` is dropped deliberately: we do not want to wait on a
    // long-running server. It is reaped by init once Remuda exits.
    command.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_ollama_binary_by_name() {
        for name in ["ollama", "Ollama", "OLLAMA", "ollama.exe"] {
            assert!(is_ollama_process(OsStr::new(name)), "should match {name:?}");
        }
    }

    #[test]
    fn does_not_match_look_alike_processes() {
        for name in [
            "ollamad",
            "ollama-exporter",
            "my-ollama",
            "olla",
            "",
            "ollama.app",
        ] {
            assert!(
                !is_ollama_process(OsStr::new(name)),
                "should not match {name:?}"
            );
        }
    }

    #[test]
    fn first_sample_never_reports_a_cpu_number() {
        // One refresh cannot produce a CPU delta. The contract says that is
        // `None` — "unknown" — and specifically not `Some(0.0)`.
        let mut sampler = Sampler::new();
        assert_eq!(sampler.sample().ollama_cpu_percent, None);
    }

    #[test]
    fn gpu_percent_is_always_unavailable() {
        let mut sampler = Sampler::new();
        assert_eq!(sampler.sample().gpu_percent, None);
    }

    #[test]
    fn reports_real_memory_totals() {
        let mut sampler = Sampler::new();
        let stats = sampler.sample();
        assert!(stats.mem_total_bytes > 0, "no total memory reported");
        assert!(
            stats.mem_used_bytes <= stats.mem_total_bytes,
            "used {} exceeds total {}",
            stats.mem_used_bytes,
            stats.mem_total_bytes
        );
    }

    /// Needs a live `ollama serve` on this machine. Ignored by default so the
    /// suite stays hermetic; run with `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_cpu_reading_after_two_samples() {
        let mut sampler = Sampler::new();
        sampler.sample();
        std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL + std::time::Duration::from_millis(50));
        let stats = sampler.sample();
        let cpu = stats
            .ollama_cpu_percent
            .expect("no ollama process found — start `ollama serve` first");
        println!("ollama cpu = {cpu}%");
        assert!(cpu >= 0.0);
    }

    /// Actually launches `ollama serve`. Ignored for the same reason.
    #[test]
    #[ignore]
    fn live_start_ollama() {
        start_ollama().expect("failed to spawn ollama serve");
    }
}
