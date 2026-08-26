# Remuda — Product & UX Spec

> **Remuda** is a simple, chat-first desktop UI over a locally running
> [Ollama](https://ollama.com). Browse and load models, chat to test them,
> and tweak or fork a model's **Modelfile** in place — then have Ollama
> stop and reload it with your changes.
>
> Stack-agnostic: nothing here assumes a UI framework. It assumes only an
> HTTP client that can read streamed responses, talking to Ollama's local
> API at `http://127.0.0.1:11434`.

**Mockup:** [`docs/mockup.html`](docs/mockup.html) is the interactive
reference for everything below (open it in a browser). Every screen named
here maps to it 1:1.

---

## 1. What it is

A calm, local-first desktop app that lets a person:

1. **Load a model in one place** — a global model control in the top nav
   opens a **load pane** listing every installed model. Pick a model and a
   **Modelfile** (the base/"OG", or a tuned variant), click **Load**, and
   Remuda loads it in Ollama with a progress bar.
2. **Chat to test it** — chats live down the left. Each is a saved session
   that **remembers the model it ran on**; **New chat** opens on the
   currently loaded model.
3. **Tweak the Modelfile in place** — open the Modelfile editor without
   leaving the chat context (the chat list stays put). Edit the system
   prompt and parameters via a friendly form *or* the raw Modelfile.
4. **Save or Save as** — **Save** overwrites the current Modelfile;
   **Save as…** asks for a name and a directory and creates a new tuned
   variant. Either way Remuda **stops the model and reloads it** through
   Ollama so your chats immediately use the new Modelfile.
5. **Pull new models** from the registry with visible progress.
6. **Point at an Ollama server** and manage app settings.

**Non-goals (v1):** training/fine-tuning weights, multi-user/remote hosting,
prompt libraries or eval harnesses, cloud sync, GGUF import UI (deferred —
§12). Remuda is a *management + tinkering* surface, not an IDE.

## 2. Who it's for

Developers and hobbyists who already run Ollama from the terminal and want a
faster, less-memorized way to load models, iterate on a Modelfile, and test
the result. The bar: **anything you'd do with `ollama list`, `ollama run`,
`ollama show`, `ollama create`, `ollama pull`, `ollama rm`** — without
remembering the flags.

## 3. Hard requirement: Ollama must be running

Remuda is a client. It owns no models and runs no inference. If it can't
reach the server, it is mostly inert and says so plainly (§9).

- Default server: `http://127.0.0.1:11434` (Ollama's default).
- The address is configurable (§8) but **defaults to loopback**, and Remuda
  never binds a listener of its own.
- On launch, and on a timer, Remuda health-checks the server
  (`GET /api/version`).

## 4. Look & feel

- **Palette: Embigo** — ShipPromptly's warm-neutral **dark** surface with an
  **indigo→violet** brand gradient (`#5f63c4 → #6b4fa8`). Because Embigo is
  dark-committed, Remuda is **single-theme dark** by design — no light mode,
  no theme toggle.
- **Type:** **Inter** for UI/prose, **IBM Plex Mono** for everything
  machine-facing — model tags, Modelfile text, parameters, the token stream.
  The split *is* the identity: human words vs. machine words.
- **Semantic colour** (green/amber/red) is kept separate from the indigo
  brand — the brand is spent only on the primary action and active state.
- Design tokens live in one place (CSS custom properties in the mockup);
  change the tokens, not scattered literals.

## 5. Information architecture

```
┌ Global nav ──────────────────────────────────────────────┐
│ ● Remuda │ [ llama3.1:8b · Original ▾ ]   [connected] │   ← model control
├──────────────┬───────────────────────────────────────────┤
│ Chats        │ Chat · Modelfile                          │  ← section tabs
│              │                                            │
│ + New chat   │  (Chat, the in-context Modelfile editor,   │
│ ─ Recent     │   Pull, or Settings — the Chats list stays │
│  Undo a…  ●  │   visible for all of them)                 │
│  Explain… ○  │                                            │
│  …           │                                            │
│ Get Models·⚙ │                                            │
└──────────────┴───────────────────────────────────────────┘
```

- **Global nav (top):** the **model control** is the centrepiece — it shows
  the loaded model + Modelfile and opens the load pane (§5.1). Also the
  connection status.
- **Chats (left):** the saved-session list; a persistent rail that stays
  visible on every surface — Pull and Settings open in the main area beside
  it, not over the whole window.
- **Section tabs:** Chat · Modelfile. Pull and Settings are *not*
  tabs — they open from the Chats footer's **Get Models** button and gear.

## 5.1 Model control + load pane (global)

The load pane is how a model becomes the *loaded* model.

- **Model** — a list of **all installed models** (`ollama list`). A tuned
  variant selects its base automatically.
- **Modelfile** — for the chosen base: **Original (base)**, any **tuned
  variants** of it, and **＋ New Modelfile** (jumps to the editor, §5.4).
- **Load** — loads the effective model in Ollama, showing a progress bar
  (`loading… → loaded`). **Choosing and loading a model is the explicit act**
  — the top control then reflects it.
- **Eject** — hands the loaded model's memory back without waiting for
  `keep_alive` to expire. It sits beside Load and appears **only while
  something is loaded**, naming the tag it frees — which is whatever is in
  memory, not the pane's current selection. Ejecting isn't a mode: Ollama
  re-loads on demand, so the next chat or Load warms the weights again. It's
  unavailable while a reply is streaming (§8) and while the server is
  unreachable; a failure surfaces verbatim in the pane (§9) and the model
  stays loaded.

Source: `GET /api/tags` for the list, `GET /api/ps` for what's loaded.
Loading = a warm request (`POST /api/generate` with an empty `prompt`, or
`/api/chat`) with the configured `keep_alive`. Ejecting = the same request
with `keep_alive: 0`.

## 5.2 Chats (left)

- Each row: the conversation **title**, and **underneath it the model tag**
  it ran on, with a status dot — **green** if that model is loaded now,
  **hollow amber + "unloaded"** if not.
- **＋ New chat** opens an empty session on the **currently loaded** model +
  Modelfile.
- Sessions persist and are sorted most-recent first.

## 5.3 Chat / Test (main)

- Streaming assistant output (token caret). Composer: `Enter` sends,
  `Shift+Enter` newlines. A note reminds that messages *test* the model and
  don't change its saved Modelfile.
- **Reopening a session whose model is unloaded.** A session stores its
  effective model tag. On open, Remuda checks `/api/ps`; if that tag isn't
  loaded (Ollama dropped it after `keep_alive`, or a *different* model is
  loaded now) it shows a **"model unloaded" banner** naming the session's
  model and what *is* loaded, with **Load now**. Opening never silently
  swaps the session to a different model — the session's identity is its
  model.

Source: `POST /api/chat` with `{ model, messages, stream: true, options, keep_alive }`;
`done: true` carries `eval_count`/`eval_duration` for tok/s. Cancel = abort
the request.

## 5.4 Modelfile editor (in-context) — the core surface

Opens **in the same window as the chat, with the Chats list still visible**,
so tuning never loses your place. Two columns:

**Left — friendly form.** Each control labelled with the Modelfile keyword it
maps to, so the mapping is learnable:

| Control | Modelfile | Notes |
| --- | --- | --- |
| Base model | `FROM` | dropdown of installed models |
| System prompt | `SYSTEM` | multiline |
| Temperature | `PARAMETER temperature` | slider 0–2 |
| Top P | `PARAMETER top_p` | slider 0–1 |
| Context length | `PARAMETER num_ctx` | slider, model-max aware |
| Stop sequences | `PARAMETER stop` (repeatable) | chip list |
| Template | `TEMPLATE` | advanced |

**Right — raw Modelfile**, syntax-highlighted — the exact text sent to
`ollama create`.

**Sync contract (must-hold):**

- The **raw Modelfile is the source of truth**; the form is a projection.
- Editing a control regenerates its line(s), preserving unmanaged lines
  (comments, `LICENSE`, `ADAPTER`, `MESSAGE`, advanced `TEMPLATE`) verbatim.
- Editing the raw text re-parses into the form; anything the form can't
  represent stays in the raw text and surfaces as an "advanced" note.
- **Never silently discard Modelfile content the form doesn't model.** This
  is the cardinal rule.

**Save actions → stop & reload:**

- **Save** — overwrites the current model's Modelfile.
- **Save as…** — a dialog that **asks directly** for a **name** (`name:tag`)
  and a **directory**, then writes the Modelfile there and registers a new
  **tuned variant** with `ollama create <name> -f <chosen-path>`.
- Either action then **stops the running model and reloads it** with the new
  Modelfile — `ollama create` → unload (`keep_alive: 0`) → warm request —
  shown as a "stopping → reloading" toast. The reloaded model becomes the
  loaded model (top control updates), so open/new chats use it immediately.
- **Revert** — discard unsaved edits back to the last-loaded Modelfile.

**Why write the Modelfile to a directory.** A tuned variant is a **real,
editable Modelfile on disk** the user owns and can version — not just an
opaque entry in `~/.ollama`. The default directory is set in Settings (§5.6);
Save as… can override per-save.

**Variants.** A model whose `FROM` is another *local* model is a tuned
variant of that base. Remuda groups base + variants (the Modelfile picker in
§5.1). The mapping comes from each model's `FROM` (`/api/show`) plus the
Modelfiles found in the Modelfile directory.

Source: `POST /api/create` (legacy `modelfile` string or the newer structured
body, whichever the server version accepts; derived from the same raw
Modelfile). It streams status (`reading model metadata`, `creating new
layer`, `writing manifest`, `success`).

## 5.5 Pull (global)

- Name field (`llama3.2`, `gemma2:9b`, or a full registry URL) + **Pull**.
- A searchable **catalog** of the Ollama library — name, description,
  parameter sizes, capabilities — with installed entries marked.

  Ollama has no registry search API (`ollama.com/api/search`,
  `/v2/_catalog` and `/v2/.../tags/list` all 404; `ollama.com/search`
  returns HTML only), so the catalog is **generated at build time** by
  `scripts/fetch-catalog.mjs` scraping `ollama.com/library` into
  `app/src/pull/catalog.json`, and ships with the app. Search is local:
  instant, offline, no launch cost.

  Deliberately *not* fetched at startup. That page serves ~808 KB with no
  `ETag`/`Last-Modified`/`Cache-Control` and no compression, so every launch
  would pay the full transfer with no way to revalidate cheaply — and it
  sets a year-long tracking cookie. Staleness between releases is covered by
  the probe below.
- **Existence probe.** What the user types is checked against the registry
  manifest (`GET /v2/<ns>/<model>/manifests/<tag>`), showing exists/not-found
  plus the exact download size before they commit. This covers models
  published after the catalog was generated, so a day-old model is pullable
  without a catalog refresh.

  `registry.ollama.ai` sends no CORS headers, so this cannot run in the
  webview: it is a Rust command (`src-tauri/src/registry.rs`), and the
  frontend passes a model *name*, never a URL. Progressive enhancement —
  outside the desktop shell the size line is simply absent and pulling is
  unaffected. "Couldn't reach the registry" is never rendered as "no such
  model".
- **In-progress pulls** render layered progress (manifest + per-`sha256:` blob
  bars), throughput, ETA. Cancelable; partial layers resume.

Source: `POST /api/pull` `{ model, stream: true }`; aggregate
`completed/total` across layers. On success re-fetch `/api/tags`.

## 5.6 Settings (global)

- **Ollama server** URL + **Test connection** + **Apply**. The URL is
  **persisted** in `localStorage` and used for **all** API calls. *Test*
  probes the draft URL without committing; *Apply* commits it and
  immediately reconnects.
- **Connection** readout (version, model count, disk used).
- **Keep models loaded** — `keep_alive` (5 min / 30 min / forever).
- **Models directory** — read-only, with *Reveal*. Defaults to
  `~/.ollama/models`; `OLLAMA_MODELS` can relocate it and no API reports the
  real path, so treat the displayed value as the default rather than a fact.
- **Modelfile directory** — where **Save as…** writes tuned Modelfiles and
  which Remuda scans for variants. Chooseable; default `~/ollama/modelfiles`.
- **Confirm before deleting a model** — toggle.

---

## 6. Data model (client-side)

```
Model {
  tag: string             // "llama3.1:8b"
  family, parameterSize, quantization: string
  sizeBytes, contextLength: number
  isLoaded: boolean       // from /api/ps
  base: string | null     // FROM target when it's another local model
  isVariant: boolean      // base !== null
  modelfilePath: string | null
  modifiedAt: datetime
}
// Modelfile picker grouping:  base → [ Original(base), ...tuned variants ]

ModelfileDraft {
  from, system: string
  parameters: { [key]: string | number | string[] }  // stop is an array
  template?: string
  passthrough: string[]   // raw lines the form doesn't model, kept verbatim
  rawText: string         // source of truth; form is derived from this
  savePath: string        // directory + file the Modelfile is written to
}

ChatSession {
  id, title: string
  model: string           // effective tag it ran on — remembered across unloads
  messages: Message[]
  updatedAt: datetime
}
```

## 7. Ollama API surface used

| Action | Endpoint | Stream |
| --- | --- | --- |
| Health / version | `GET /api/version` | no |
| List installed | `GET /api/tags` | no |
| List loaded | `GET /api/ps` | no |
| Model detail | `POST /api/show` | no |
| Load a model | `POST /api/generate` empty prompt (or `/api/chat`) + `keep_alive` | no |
| Unload a model | `POST /api/generate` with `keep_alive: 0` | no |
| Create / save model | `POST /api/create` (`-f <chosen dir>`) | yes (status) |
| Chat / test | `POST /api/chat` | yes (tokens) |
| Pull | `POST /api/pull` | yes (progress) |
| Delete | `DELETE /api/delete` | no |
| Copy / duplicate | `POST /api/copy` | no |

All Ollama requests are same-origin to the configured loopback host. Default
Ollama needs no auth; a remote host requiring one would need an auth header
from Settings (kept out of v1 by default — §12).

One exception, and only one: the Pull pane's existence probe issues a `GET`
to `registry.ollama.ai` (§5.5). It runs in Rust rather than the webview (no
CORS headers there) and sends only the reference being checked — no
identifiers, no history.

Worth being precise about what that means, since the field doubles as the
catalog search box: a single-token query is indistinguishable from a model
name, so typing `uncensored` to search the catalog does reach the registry.
Anything that isn't a valid reference — anything with a space, and so every
multi-word query — is rejected locally before a request is made. The
build-time catalog scrape is not part of the shipped app.

## 8. States & rules

- **One loaded model** at a time in the top control; `/api/ps` is the truth.
- **Destructive actions** (Delete, Save-over-existing) confirm when the
  Settings toggle is on (default on).
- **Unsaved editor changes** prompt before navigating away.
- **`num_ctx` guardrail:** slider max reflects the model's trained context;
  exceeding it is allowed but warns.
- **Concurrency:** one streamed generation at a time; pulls run in the
  background.

## 9. Disconnected / error states

- **Server unreachable:** a persistent amber banner — *"Ollama isn't
  running."* — with **Retry** and **Start Ollama**; the connection pill goes
  amber; mutating actions disabled.
- **Model warming:** first token can lag while weights load; Chat shows a
  "warming up…" state rather than looking hung.
- **Create failed** (bad `FROM`, malformed Modelfile): the stream's error is
  surfaced verbatim by the save bar; the editor stays intact.
- **Pull failed:** inline error with Retry; completed blobs resume.
- **Version skew:** if the structured `/api/create` body is rejected, fall
  back to the legacy `modelfile` string.

## 10. Distribution

- **Install via Homebrew — not a DMG.** Ship a Homebrew formula/cask (likely
  a tap, e.g. `brew install magna-nz/tap/remuda`) so install and upgrade are
  one command and stay current. The DMG path is explicitly out.
- Remuda depends on Ollama at runtime but does **not** bundle it; the formula
  can declare Ollama a dependency or the app can prompt to install it.
- The desktop shell is stack-agnostic per this spec; whatever it's built on,
  the artifact is a signed macOS app delivered through the tap. (Linux/Windows
  packaging — a later question.)

## 11. Milestones

- **M1 — Read-only.** Connect; list models (`/api/tags` + `/api/ps`); the
  load pane; load-on-select; Settings connection test.
- **M2 — Chat.** `/api/chat` streaming + cancel; saved sessions that remember
  their model; the "model unloaded" banner off `/api/ps`; New chat on the
  loaded model.
- **M3 — Modelfile editor.** In-context editing with the chat list preserved;
  form ↔ raw sync; **Save** and **Save as…** (name + directory) →
  `ollama create -f` → stop & reload; tuned variants; delete/duplicate.
- **M4 — Pull.** `/api/pull` layered progress + curated Popular list.
- **M5 — Polish & ship.** Disconnected states, guardrails, keyboard
  shortcuts, reduced-motion, empty states; **Homebrew formula/cask** (§10).

## 12. Open questions

1. **Name.** "Remuda" — confirmed free as a Homebrew formula/cask, on npm and
   crates.io, and with no prominent same-space GitHub project as of naming.
   (A *remuda* is the herd of horses a ranch hand picks their mount from — the
   stable of local models you load and swap between.)
2. **Modelfile sync fidelity.** Which of the grammar does the form model vs.
   leave to passthrough? Proposal: `FROM`, `SYSTEM`, common `PARAMETER`s and
   `stop`; everything else passthrough + an advanced raw view.
3. **Variant discovery.** A model is a variant if its `FROM` resolves to
   another *local* model, plus any `.Modelfile` in the Modelfile directory.
   Edge cases: variant-of-a-variant, and a variant whose base was deleted.
4. **Modelfile directory vs. `~/.ollama`.** Saving writes the source
   Modelfile to a user directory *and* registers the model in Ollama's store.
   If they drift (hand-edit, or `ollama rm`), which wins? Proposal: on-disk
   Modelfile is the editable source; offer "re-create from file" + flag
   orphans.
5. **GGUF / local file import.** `FROM ./model.gguf` is a real workflow;
   deferred past v1, but design `FROM` so a "from a file" option slots in.
6. **Push / publish.** `POST /api/push` to share a created model — out of
   scope for v1; revisit.
7. **Remote/authenticated hosts.** Default is loopback, no auth. A non-
   loopback host would need an auth-header field and a clear security
   warning. Door closed in v1.
8. **Cross-platform packaging.** Homebrew covers macOS; Linux/Windows
   packaging is a later decision.
