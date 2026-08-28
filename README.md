<div align="center">
  <img src="docs/remuda-mark.svg" alt="Remuda logo" width="104" />
  <h1>Remuda</h1>
  <p><strong>A desktop app for running, testing and tuning your local Ollama models.</strong></p>
  <p>
    <a href="https://github.com/magna-nz/remuda/actions/workflows/ci.yml"><img src="https://github.com/magna-nz/remuda/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
    <a href="https://github.com/magna-nz/remuda/releases/latest"><img src="https://img.shields.io/github/v/release/magna-nz/remuda?sort=semver&label=release" alt="Latest release" /></a>
    <a href="https://github.com/magna-nz/remuda/releases"><img src="https://img.shields.io/github/downloads/magna-nz/remuda/total?label=downloads" alt="Total downloads" /></a>
    <a href="#install"><img src="https://img.shields.io/badge/Homebrew-cask-FBB040?logo=homebrew&logoColor=white" alt="Install with Homebrew" /></a>
  </p>
  <p>
    <a href="https://ollama.com"><img src="https://img.shields.io/badge/Ollama-runs%20local-000000?logo=ollama&logoColor=white" alt="Talks to a local Ollama" /></a>
    <a href="https://tauri.app"><img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Built with Tauri 2" /></a>
    <img src="https://img.shields.io/badge/macOS-12%2B%20Apple%20Silicon-000000?logo=apple&logoColor=white" alt="macOS 12+ on Apple Silicon" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License" /></a>
  </p>
  <p>
    <a href="#install">Install</a> ·
    <a href="#quick-start">Quick start</a> ·
    <a href="#what-you-get">Features</a> ·
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

## Why

Ollama is a good runtime with a terminal-shaped workflow. Getting a model to behave means bouncing
between `ollama list`, `ollama run`, `ollama show`, and a Modelfile in another editor — and that
round trip is slow enough that most people try one system prompt and settle.

**Remuda closes the loop in one window: load a model, chat to test it, edit its Modelfile beside
the chat, save.** Remuda rebuilds through `ollama create` and reloads, so your very next message
uses the change. No tab switching, no `ollama create` by hand, no losing your place.

Then it makes that loop worth running more than once. Every save is snapshotted and diffable, so
you can see what you changed and go back. Two configurations can answer the same prompt side by
side on a pinned seed, so you're reading the change and not sampling noise. If a model claims tool
support, you can find out whether it actually emits well-formed calls. Other Ollama GUIs are chat
windows that happen to talk to Ollama; this one is for the tuning.

Nothing leaves your machine. Remuda is a client for the Ollama you already run on `127.0.0.1`.

> A *remuda* is the herd of horses a ranch hand picks their mount from each day. Your models are
> the herd, one is saddled at a time, and swapping should take seconds.

## What you get

### The loop

| | |
| --- | --- |
| **Modelfile editor** | Opens beside the chat, chat list still visible. A form for the common fields, synced both ways with the raw text, which stays the source of truth. `LICENSE`, `ADAPTER`, `MESSAGE` and comments round-trip byte for byte. Save, and the model rebuilds and reloads. |
| **Modelfile history** | Every save writes a snapshot with a line diff against the one before it. **Restore** loads that text as an unsaved draft — it never rebuilds the model behind your back. Hand-edits made outside Remuda are flagged as drift rather than papered over. |
| **Compare (A/B)** | One prompt, two configurations, two lanes. Run sequentially rather than concurrently so each lane's tok/s means something, on one pinned seed so what you're reading is the configuration and not sampling noise. Per-metric win markers, and no invented aggregate score. |
| **Tool playground** | Appears when the loaded model positively claims `tools`. Write schemas, chat against them, and see every `tool_call` validated field by field — `wrong type`, `not in enum`, `unknown key`, `missing`. The verdict is the feature, not the pretty-printing. |
| **Per-chat parameters** | Temperature, top-p, top-k, seed and the rest, overridden for the current chat only. No `ollama create`, no reload. **Bake into Modelfile** when a setting earns its place. |
| **Save as…** | Fork a tuned variant, optionally quantising it on the way in. Remuda runs `ollama create`, stops the old model and loads the new one. A variant is a real file on disk, not an opaque entry in `~/.ollama`. |

### Around it

| | |
| --- | --- |
| **Load pane** | Every installed model, with tuned variants grouped under their base. Pick a Modelfile, hit Load, watch real progress. **Eject** hands the memory back without waiting out `keep_alive`. |
| **Chat** | Saved sessions that remember the model they ran on, and offer to load it again rather than silently swapping. Streaming replies, cancel, and a warming indicator. |
| **Reasoning and vision** | Thinking is folded into its own collapsed block above the answer, and never sent back as context. Vision models get a paperclip. Embedding models say up front that they can't chat. |
| **Fit predictor** | Before you load: will this model, at this context length, fit in the GPU's share of memory? Computed from the architecture Ollama reports and the RAM the host actually has, self-calibrating against each clean load. When the server won't say enough, it refuses to predict rather than fabricating a number. |
| **Runtime telemetry** | `all on GPU · 5.6 GB` in the top bar, or an amber `28.4 GB GPU + 9.1 GB RAM` the moment a model spills. Behind it: host RAM, Ollama's CPU load, the context the runner started with, and a live `keep_alive` countdown. Figures that can't be read honestly are absent, never zero. |
| **Pull** | Per-layer progress, cancel and retry, plus a curated list of popular models with the installed ones marked. |
| **Per-reply stats** | Generation tok/s, prompt-eval tok/s, load time, total time, and context used. |
| **Leave with it** | **Copy as `curl`** or **as `ollama run`** yields the exact request behind any reply. **Promote to `SYSTEM`** stages a good answer straight into the Modelfile. **Re-roll** repeats a reply holding the seed, or changing only the seed. |

## Requirements

* [Ollama](https://ollama.com) running locally. Remuda is a client, so it doesn't bundle models
  or run inference itself.
* macOS 12+ on Apple Silicon. <!-- PLACEHOLDER: Intel/universal + Linux/Windows builds are planned -->

```sh
brew install ollama
ollama serve
```

## Install

```sh
brew install --cask magna-nz/tap/remuda
```

That pulls in [magna-nz/homebrew-tap](https://github.com/magna-nz/homebrew-tap) on the way through,
so there's no separate `brew tap` step.

The build is unsigned — no Apple Developer program — so macOS would normally quarantine it and
refuse to open it. The cask clears that flag as part of the install, so the app just launches.

Afterwards:

```sh
brew upgrade --cask remuda     # move to the latest release
brew uninstall --cask remuda   # remove it
```

<sub>If macOS ever balks anyway, run
<code>xattr -dr com.apple.quarantine /Applications/Remuda.app</code>. See
<a href="packaging/homebrew/README.md">packaging/homebrew</a> for release and tap mechanics.</sub>

Or from source:

```sh
git clone https://github.com/magna-nz/remuda.git
cd remuda/app && npm install
cd ../src-tauri && cargo tauri dev
```

## Quick start

1. Start Ollama with `ollama serve`. Remuda's connection pill goes green.
2. Click the model control in the top bar, pick a model, hit **Load**.
3. Hit **＋ New chat** and say hello.
4. Not the behaviour you wanted? Click the pencil, edit the system prompt, **Save**. The model
   reloads and your next message uses it.
5. Happy with it? **Save as…** keeps it as a named variant with the original left alone.

No models installed yet? The load pane offers **Pull your first model**.

## Look and feel

Dark only. A warm neutral ground with an indigo to violet brand, set in **Inter**, with **IBM Plex
Mono** for anything machine-facing: model tags, Modelfiles, parameters, the token stream.

## Documentation

**[magna-nz.github.io/remuda](https://magna-nz.github.io/remuda/)** — the user guide: getting
started, the Modelfile editor, comparing configurations, what the memory readout means, and
troubleshooting.

For working on Remuda itself:

* [`SPEC.md`](SPEC.md) is the full product spec: every surface, the Ollama calls behind it, the
  Modelfile sync contract, and the open questions.
* [`docs/SPEC-tuning.md`](docs/SPEC-tuning.md) specs the tuning loop — history, A/B, tools, the
  fit predictor and telemetry — with the build log at the end.
* [`docs/mockup.html`](docs/mockup.html) is the interactive design mockup the app is built to.
* [`packaging/homebrew/`](packaging/homebrew/README.md) covers release and tap mechanics.

## Contributing

You'll need [Node](https://nodejs.org) 22+ and a [Rust](https://rustup.rs) toolchain.

```sh
cd app
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsc && vite build
```

For the desktop shell, run `cargo check` or `cargo tauri dev` from `src-tauri/`.

CI runs both sets of gates on every pull request and on pushes to `main`, plus `cargo fmt
--check` and `cargo clippy -D warnings`.

The release workflow builds the macOS app on a `v*` tag, publishes it as a GitHub release, and
pushes the rendered Homebrew cask to the tap. It refuses to build if the tag disagrees with any of
the six version fields spread across `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, `package.json`
and `package-lock.json`, so bump them with the script rather than by hand:

```sh
./scripts/version.sh --set 0.3.0
```

`./scripts/version.sh --check` is the same gate, and CI runs it on every pull request. See
[`packaging/homebrew/`](packaging/homebrew/README.md) for the full release flow.

## License

[MIT](LICENSE).
