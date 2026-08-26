//! Registry probe for the Pull pane (SPEC.md §5.5).
//!
//! Ollama has no search API, so Remuda ships a generated catalog for
//! browsing. This covers the other half: confirming that a name the user
//! typed *actually exists* — including models published after our catalog
//! was generated — and reporting its real download size before they commit.
//!
//! This lives in Rust for two reasons. `registry.ollama.ai` sends no
//! `Access-Control-Allow-Origin`, so a webview `fetch` can't read the
//! response; and building the URL here means the frontend passes a model
//! *name*, never a URL, so this can't be turned into a general-purpose
//! request proxy.
//!
//! This is the only outbound (non-loopback) request Remuda makes.

use serde::Serialize;

const REGISTRY: &str = "https://registry.ollama.ai/v2";
const DEFAULT_NAMESPACE: &str = "library";
const DEFAULT_TAG: &str = "latest";
/// Generous next to real names (the longest in the library is ~40 chars),
/// but bounded so a pathological input can't be reflected into a URL.
const MAX_PART: usize = 128;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// The manifest resolved (HTTP 200).
    pub exists: bool,
    /// Sum of every layer plus the config blob — what the pull will transfer.
    /// 0 when `exists` is false.
    pub total_bytes: u64,
    /// Normalised `namespace/model:tag` we actually asked about, so the UI can
    /// show what it resolved (e.g. `llama3.2` → `library/llama3.2:latest`).
    pub resolved: String,
}

/// One path segment of a model reference.
///
/// Deliberately stricter than the registry itself: alphanumerics plus
/// `. _ -`, non-empty, bounded, and never a relative-path token. Rejecting
/// `/`, `?`, `#`, `%` and `..` here is what keeps a crafted name from
/// escaping the path we intend or smuggling in a query string.
fn valid_part(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= MAX_PART
        && part != "."
        && part != ".."
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Split `[namespace/]model[:tag]` into the pieces the manifest URL needs.
fn parse_reference(reference: &str) -> Result<(String, String, String), String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("empty model name".into());
    }
    // A full URL is legal input to `ollama pull`, but we only know how to
    // probe the default registry. Say so rather than guessing — the pull
    // itself is unaffected.
    if reference.contains("://") {
        return Err("only registry.ollama.ai references can be probed".into());
    }

    let (path, tag) = match reference.rsplit_once(':') {
        Some((p, t)) => (p, t),
        None => (reference, DEFAULT_TAG),
    };
    let (namespace, model) = match path.split_once('/') {
        Some((ns, m)) => (ns, m),
        None => (DEFAULT_NAMESPACE, path),
    };

    // `valid_part` rejects `/`, so `a/b/c` fails here rather than silently
    // probing the wrong path.
    for part in [namespace, model, tag] {
        if !valid_part(part) {
            return Err(format!("invalid model reference: {reference}"));
        }
    }

    Ok((namespace.to_string(), model.to_string(), tag.to_string()))
}

#[derive(serde::Deserialize)]
struct Manifest {
    #[serde(default)]
    config: Option<Blob>,
    #[serde(default)]
    layers: Vec<Blob>,
}

#[derive(serde::Deserialize)]
struct Blob {
    #[serde(default)]
    size: u64,
}

/// Probe the registry for `[namespace/]model[:tag]`.
///
/// `Ok(exists: false)` is a real answer (the name isn't published), distinct
/// from `Err`, which means we couldn't find out — offline, DNS failure, a 5xx.
/// The UI must not present the latter as "this model doesn't exist".
#[tauri::command]
pub async fn probe_model(reference: String) -> Result<Probe, String> {
    let (namespace, model, tag) = parse_reference(&reference)?;
    let resolved = format!("{namespace}/{model}:{tag}");
    let url = format!("{REGISTRY}/{namespace}/{model}/manifests/{tag}");

    let client = reqwest::Client::builder()
        .user_agent(concat!("Remuda/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(10))
        // The host is fixed and the path is built from a validated name; not
        // following redirects keeps it that way, rather than letting a 3xx
        // hand this request to somewhere we never intended to talk to.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;

    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Probe { exists: false, total_bytes: 0, resolved });
    }
    if !res.status().is_success() {
        return Err(format!("registry returned {}", res.status()));
    }

    let manifest: Manifest = res.json().await.map_err(|e| e.to_string())?;
    let total_bytes = manifest.layers.iter().map(|l| l.size).sum::<u64>()
        + manifest.config.map_or(0, |c| c.size);

    Ok(Probe { exists: true, total_bytes, resolved })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_name_defaults_namespace_and_tag() {
        let (ns, m, t) = parse_reference("llama3.2").unwrap();
        assert_eq!((ns.as_str(), m.as_str(), t.as_str()), ("library", "llama3.2", "latest"));
    }

    #[test]
    fn explicit_tag_and_namespace() {
        let (ns, m, t) = parse_reference("some-user/my-model:q4_K_M").unwrap();
        assert_eq!((ns.as_str(), m.as_str(), t.as_str()), ("some-user", "my-model", "q4_K_M"));
    }

    #[test]
    fn rejects_path_traversal_and_url_smuggling() {
        for bad in [
            "../../etc/passwd",
            "library/../../evil",
            "..",
            "a/b/c",
            "model?query=1",
            "model#frag",
            "model%2f",
            "http://evil.test/x",
            "",
            "   ",
        ] {
            assert!(parse_reference(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn rejects_overlong_part() {
        assert!(parse_reference(&"a".repeat(MAX_PART + 1)).is_err());
    }

    /// Hits the real registry. Ignored by default so the suite stays offline;
    /// run with `cargo test -- --ignored --nocapture` when changing the
    /// manifest handling.
    #[test]
    #[ignore]
    fn live_probe_round_trip() {
        let found = tauri::async_runtime::block_on(probe_model("llama3.2".into())).unwrap();
        assert!(found.exists);
        assert_eq!(found.resolved, "library/llama3.2:latest");
        // ~2 GB; assert a broad band so a re-tag upstream doesn't fail this.
        assert!(
            found.total_bytes > 1_000_000_000 && found.total_bytes < 5_000_000_000,
            "unexpected size {}",
            found.total_bytes
        );

        let missing =
            tauri::async_runtime::block_on(probe_model("definitely-not-a-model-xyz".into()))
                .unwrap();
        assert!(!missing.exists);
        assert_eq!(missing.total_bytes, 0);

        println!("llama3.2 => {} bytes", found.total_bytes);
    }
}
