<div align="center">
  <img src="docs/remuda-mark.svg" alt="Remuda logo" width="104" />
  <h1>Remuda</h1>
  <p><strong>A desktop app for running, testing and tuning your local Ollama models.</strong></p>
  <p>
    <a href="https://github.com/magna-nz/remuda/actions/workflows/ci.yml"><img src="https://github.com/magna-nz/remuda/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
    <a href="https://github.com/magna-nz/remuda/releases/latest"><img src="https://img.shields.io/github/v/release/magna-nz/remuda?sort=semver&label=release" alt="Latest release" /></a>
    <a href="https://github.com/magna-nz/remuda/releases"><img src="https://img.shields.io/github/downloads/magna-nz/remuda/total?label=downloads" alt="Total downloads" /></a>
    <a href="https://ollama.com"><img src="https://img.shields.io/badge/Ollama-runs%20local-000000?logo=ollama&logoColor=white" alt="Talks to a local Ollama" /></a>
    <a href="https://tauri.app"><img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Built with Tauri 2" /></a>
    <img src="https://img.shields.io/badge/macOS-12%2B%20Apple%20Silicon-000000?logo=apple&logoColor=white" alt="macOS 12+ on Apple Silicon" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License" /></a>
  </p>
  <p>
    <a href="#-install">Install</a> ·
    <a href="#-quick-start">Quick start</a> ·
    <a href="#-what-you-get">Features</a> ·
    <a href="https://magna-nz.github.io/remuda/">Docs</a> ·
    <a href="SPEC.md">Spec</a>
  </p>
</div>

<br />

<div align="center">
  <img src="docs/demo.gif" alt="Loading a model, chatting with it, and editing its Modelfile in Remuda" width="820" />
  <br />
  <sub><strong>Chats on the left, the loaded model in the top bar, the Modelfile one click away.</strong></sub>
</div>

<br />

## 🤔 Why

Tuning a model on Ollama means bouncing between `ollama list`, `ollama run`, `ollama show` and a
Modelfile in another editor — slow enough that most people try one system prompt and settle.

**Remuda closes the loop in one window: load a model, chat to test it, edit its Modelfile beside
the chat, save.** It rebuilds through `ollama create` and reloads, so your next message uses the
change. Other Ollama GUIs are chat windows; this one is for the tuning.

Nothing leaves your machine — Remuda is a client for the Ollama you already run on `127.0.0.1`.

> A *remuda* is the herd of horses a ranch hand picks their mount from each day.

## ✨ What you get

* 📝 **Modelfile editor** — opens beside the chat. Form and raw text stay in sync; the text is the
  source of truth and round-trips byte for byte. Save rebuilds and reloads.
* 🕰️ **Modelfile history** — every save snapshotted with a line diff. Restore loads a draft rather
  than rebuilding behind your back; outside edits show up as drift.
* 🔀 **Compare (A/B)** — one prompt, two configurations, run sequentially on a pinned seed so you're
  reading the change and not sampling noise.
* 🧰 **Tool playground** — for models that claim `tools`: write schemas and see every `tool_call`
  validated field by field.
* 🎛️ **Per-chat parameters** — temperature, seed and the rest for the current chat only, with **Bake
  into Modelfile** when one earns its place.
* 🍴 **Save as…** — fork a tuned variant, optionally quantised, as a real file on disk.
* 📊 **Fit predictor and telemetry** — will this model at this context fit in GPU memory, and once
  loaded, where it actually landed. Figures that can't be read honestly are absent, never zero.
* ➕ **The rest** — model load pane with variants grouped under their base, saved chats, streaming
  with cancel, folded reasoning blocks, vision, pull with per-layer progress, per-reply stats, and
  **Copy as `curl`** / **Promote to `SYSTEM`** / **Re-roll**.

The [docs site](https://magna-nz.github.io/remuda/) covers all of it in detail.

## 📋 Requirements

[Ollama](https://ollama.com) running locally, and macOS 12+ on Apple Silicon. Remuda is a client —
it doesn't bundle models or run inference itself.
<!-- PLACEHOLDER: Intel/universal + Linux/Windows builds are planned -->

```sh
brew install ollama
ollama serve
```

## 📦 Install

```sh
brew install --cask magna-nz/tap/remuda
```

That pulls in [magna-nz/homebrew-tap](https://github.com/magna-nz/homebrew-tap) on the way, so
there's no separate `brew tap` step. The build is unsigned, but the cask clears the quarantine
flag, so the app just launches. Then `brew upgrade --cask remuda` and `brew uninstall --cask
remuda` do what you'd expect.

<sub>If macOS balks anyway, run
<code>xattr -dr com.apple.quarantine /Applications/Remuda.app</code>.</sub>

Or from source:

```sh
git clone https://github.com/magna-nz/remuda.git
cd remuda/app && npm install
cd ../src-tauri && cargo tauri dev
```

## 🚀 Quick start

1. Start Ollama with `ollama serve`. Remuda's connection pill goes green.
2. Click the model control in the top bar, pick a model, hit **Load**.
3. Hit **＋ New chat** and say hello.
4. Not the behaviour you wanted? Click the pencil, edit the system prompt, **Save**. The model
   reloads and your next message uses it.
5. Happy with it? **Save as…** keeps it as a named variant, original left alone.

No models installed yet? The load pane offers **Pull your first model**.

## 📚 Documentation

* **[magna-nz.github.io/remuda](https://magna-nz.github.io/remuda/)** — the user guide.
* [`SPEC.md`](SPEC.md) — full product spec: every surface, the Ollama calls behind it, the
  Modelfile sync contract.
* [`docs/SPEC-tuning.md`](docs/SPEC-tuning.md) — the tuning loop, with the build log at the end.
* [`docs/mockup.html`](docs/mockup.html) — the design mockup the app is built to.
* [`packaging/homebrew/`](packaging/homebrew/README.md) — release and tap mechanics.

## 🛠️ Contributing

You'll need [Node](https://nodejs.org) 22+ and a [Rust](https://rustup.rs) toolchain.

```sh
cd app
npm run typecheck && npm test && npm run build
```

For the desktop shell, `cargo check` or `cargo tauri dev` from `src-tauri/`. CI runs both sets of
gates plus `cargo fmt --check` and `cargo clippy -D warnings`.

Releases build on a `v*` tag and refuse to proceed if the tag disagrees with any of the six
version fields across the manifests, so bump with the script rather than by hand:

```sh
./scripts/version.sh --set 0.3.0
```

## ⚖️ License

[MIT](LICENSE).
