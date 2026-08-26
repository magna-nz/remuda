# Remuda

A simple, chat-first desktop UI for [Ollama](https://ollama.com). Load any
installed model, chat to test it, and tweak or fork its **Modelfile** in
place — Remuda then has Ollama stop and reload the model with your changes.

> **Status:** design stage. This repo currently holds the product spec and an
> interactive mockup — no application code yet. See [`SPEC.md`](SPEC.md).

## What it does

- **One place to load models.** A global model control opens a load pane
  listing every installed model; pick a model and a Modelfile (the base or a
  tuned variant) and **Load** — Remuda loads it in Ollama.
- **Chats down the left.** Each chat is a saved session that remembers the
  model it ran on; if that model isn't loaded when you reopen it, Remuda says
  so. **New chat** opens on the currently loaded model.
- **Edit the Modelfile without leaving the chat.** A friendly form and the
  raw Modelfile, kept in sync.
- **Save / Save as.** Save overwrites; Save as… asks for a name and a folder
  and creates a new tuned variant. Either one stops and reloads the model via
  Ollama so your chats use the new Modelfile right away.
- **Pull** new models from the registry with visible progress.

## Look & feel

Single-theme dark, using ShipPromptly's **Embigo** palette (warm-neutral dark
ground, indigo→violet brand) with **Inter** + **IBM Plex Mono**.

## Requirements

- **Ollama** running locally (`http://127.0.0.1:11434`). Remuda is a client —
  it doesn't bundle Ollama or run inference itself.

## Install

Distribution is **Homebrew, not a DMG** (see [`SPEC.md` §10](SPEC.md)):

```bash
brew install --cask magna-nz/tap/remuda
```

This becomes available from the first tagged release (the tap repo,
`magna-nz/homebrew-tap`, is created then — see
[`packaging/homebrew/README.md`](packaging/homebrew/README.md)). Until a
release exists, run from source instead:

```bash
git clone https://github.com/magna-nz/remuda.git
cd remuda/app
npm install
npm run dev        # Vite dev server at http://localhost:5173
```

or, for the full desktop shell (Vite dev server + the Tauri window
together), from `src-tauri/`:

```bash
cargo tauri dev
```

Either way requires [Ollama](https://ollama.com) running locally — see
[Requirements](#requirements) above.

## Development

Requirements: [Node](https://nodejs.org) 22+, and a [Rust](https://rustup.rs)
toolchain for the Tauri shell.

```bash
cd app
npm install
npm run dev        # Vite dev server at http://localhost:5173
```

To run the full desktop shell (Vite dev server + the Tauri window together),
use the [Tauri CLI](https://tauri.app) from `src-tauri/`:

```bash
cargo tauri dev
```

## The mockup

[`docs/mockup.html`](docs/mockup.html) — open it in a browser to click
through the whole UI (load pane, chats, in-context Modelfile editing with
save + reload, pull, settings).

## License

No license yet — all rights reserved by default until one is added.
