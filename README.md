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
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="Runs on macOS and Linux" />
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
* 🏁 **Benchmark** — keep a set of prompts and run them against several configurations at once: two
  models against each other, or one model under two Modelfiles. One row per prompt, one column per
  lane, every answer on the same pinned seed. It shows you what differs and never scores a lane.
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

[Ollama](https://ollama.com) running locally, plus either macOS 12+ on Apple Silicon or a
glibc-based x86-64 Linux with GTK 3 and WebKitGTK 4.1 (Ubuntu 22.04 and newer, and equivalents).
Remuda is a client — it doesn't bundle models or run inference itself.
<!-- PLACEHOLDER: Intel/universal macOS and Windows builds are planned -->

On Linux the fit predictor stays quiet: it sizes a model against unified memory, and there is no
supported way to read a discrete card's VRAM, so Remuda reports no prediction rather than a
confident wrong one. Everything else works the same.

```sh
brew install ollama
ollama serve
```

## 📦 Install

### macOS

```sh
brew install --cask --force magna-nz/tap/remuda
```

That pulls in [magna-nz/homebrew-tap](https://github.com/magna-nz/homebrew-tap) on the way, so
there's no separate `brew tap` step. The build is unsigned, but the cask clears the quarantine
flag, so the app just launches. Then `brew upgrade --cask --force remuda` and `brew uninstall
--cask remuda` do what you'd expect.

<sub><code>--force</code> is not busywork. If <code>/Applications/Remuda.app</code> has gone
missing while Homebrew still has it on the books — you moved it to the Trash, or a local build
replaced it — then plain <code>install</code> and <code>upgrade</code> both dead-end on
<em>"It seems the App source '/Applications/Remuda.app' is not there"</em>, because the upgrade
tries to move the old app back to staging before installing the new one. Nothing the cask
declares can recover from that; <code>--force</code> is the only way through. The trade is that
an existing <code>Remuda.app</code> gets overwritten rather than flagged.</sub>

<sub>If macOS balks anyway, run
<code>xattr -dr com.apple.quarantine /Applications/Remuda.app</code>.</sub>

### Linux

x86-64, glibc 2.35+ (Ubuntu 22.04 and newer, Debian 12, Fedora 36+, and equivalents). Grab the
`.deb` or the AppImage from the [latest release](https://github.com/magna-nz/remuda/releases/latest):

```sh
sudo apt install ./Remuda_*_amd64.deb
```

Or, for anything not Debian-based, the AppImage runs as-is:

```sh
chmod +x Remuda_*_amd64.AppImage && ./Remuda_*_amd64.AppImage
```

Ollama on Linux usually runs as a systemd service. If Remuda says it isn't running:

```sh
sudo systemctl start ollama
```

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
