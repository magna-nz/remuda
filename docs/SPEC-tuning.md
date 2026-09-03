# Remuda — the tuning loop

A companion to [`SPEC.md`](../SPEC.md). Same voice, same rules; this covers
five features that deepen the one thing Remuda already does that no other
Ollama GUI does — **edit → reload → retest**.

The strategic premise, stated once so every decision below can be checked
against it: *every competing Ollama GUI is a chat window.* Open WebUI, Msty,
Enchanted, Chatbox and LM Studio all compete on chat surface — personas,
RAG, plugins. Remuda does not win there and should not try. Remuda's user is
the person **tuning** a model, and the loop they run is the product. Every
feature here closes that loop; none of them is a chat feature.

Numbered `T1`–`T6` so they can be referenced without colliding with
`SPEC.md`'s own sections.

| | Feature | Lives in | New Ollama calls | Effort |
| --- | --- | --- | --- | --- |
| **T1** | Modelfile history | Modelfile editor, third view | none | Small |
| **T2** | A/B run | Chat, second lane | none | **Large** (was Medium — see Wave 0) |
| **T3** | Tool-calling playground | New capability-gated tab | `tools` on `/api/chat` | Medium |
| **T4** | Fit predictor | Load pane | none (reads `/api/show`) | Medium |
| **T5** | Bench — prompt regression set | Chats rail, second group | none | Large |
| **T6** | Four small ones | various | none | Trivial each |
| **T7** | Runtime telemetry | Top bar + popover | none | Small–Medium |

`T1` and `T2` are the ones to build first, and in that order: `T1` de-risks
the loop that everything else runs inside, and `T5` is `T1` and `T2`
composed — building it before them would mean building them badly.

---

## T1 — Modelfile history

### What it is

Every **Save** and **Save as…** snapshots the Modelfile's `rawText` into a
per-model ring buffer. A third view in the Modelfile editor — beside **Form**
and **Raw** — lists those snapshots newest-first, diffs any of them against
the working text, and restores one.

### Why it earns its place

Remuda's whole pitch is that the edit→reload→retest loop is fast. A fast loop
makes *mistakes* fast too, and the failure the loop creates is specific:
**"I had it behaving three saves ago and I can't get back."** Right now the
only record of what the Modelfile used to say is whatever the user
remembered to copy out. No other Ollama GUI keeps this, and Remuda is
uniquely placed to — `rawText` is already the declared source of truth
(`SPEC` §6), and every write already funnels through one save path.

### Surface

A third segment in the editor's existing view toggle: **Form · Raw ·
History**. Not a modal, not a new tab. History splits the editor pane into a
narrow left timeline and a unified diff on the right.

Each timeline entry shows relative time, the save kind (**Save** or **Save
as…**), and a summary of the change (`+4 −1 · SYSTEM, temperature`). The
entry matching the working text is marked **current**.

### Data model

```
ModelfileSnapshot {
  id: string
  tag: string            // the model tag this Modelfile builds
  rawText: string        // verbatim, the whole file
  savePath: string
  savedAt: datetime
  kind: "save" | "saveas" | "restore"
  parentId: string | null   // the snapshot this was edited from
}
```

Persisted to `localStorage` under `remuda.modelfile-history.v1`, keyed by
tag. Modelfiles run 1–2 KB, so a 40-deep ring per model is ~80 KB — an order
of magnitude under the budget that forced image thumbs in `SPEC` §6. The
ring evicts oldest-first and **never evicts the oldest entry for a tag that
has only one**, so a model always retains at least the state it was first
seen in.

### Rules

- **Restore does not create.** Choosing **Restore this** loads the snapshot
  into the editor as an *unsaved draft* and switches to Raw. It does not run
  `ollama create` and does not reload the model. The user still has to hit
  **Save**, which goes through the normal confirm (`SPEC` §8) and writes a
  new snapshot of kind `restore`. A history feature that silently rebuilds
  a model on click is a trap, not a safety net.
- **Drift is surfaced, not resolved.** If the live Modelfile hashes to
  nothing in the ring, the timeline shows an **edited outside Remuda** entry
  at the top rather than pretending the last snapshot is current. This is
  `SPEC` §12 question 4 observed, not answered.
- **Deleting a model does not delete its history.** An orphaned ring is
  labelled as such and offers **Re-create from this** — which is the one
  place Remuda can rescue a model the user removed by hand.
- Snapshots are content-addressed by hash; saving without changing the text
  does not add an entry.

### Touches

`ui/state.tsx` (a store slice + the save path), a new `ui/ModelfileHistory.tsx`
and a small line-diff helper. No API changes.

---

## T2 — A/B run

### What it is

One prompt, two configurations, two columns, both sets of numbers. The chat
header gets a **⇄ Compare** toggle; the transcript becomes two lanes, **A**
and **B**, each with its own model + Modelfile + parameter overrides. The
single composer at the bottom sends to both, and each lane streams and
scores its own reply.

### Why it earns its place

This is the thing the audience already does, badly, in two terminal windows
with a scrollback buffer between them. It is the *actual* question behind
every Modelfile edit — *is this better?* — and today Remuda answers it the
same way `ollama run` does: by making the user remember what the last answer
looked like.

No local Ollama GUI does side-by-side. It is the single most visible
differentiator on this list.

### Surface

Two lanes inside the existing chat, not a new destination. The user is
already in a conversation when the question arises; sending them somewhere
else loses the context that prompted it.

Each lane carries a **config chip** at its head — `llama3.1:8b · Original`
or `llama3.1:8b · terse-v2 · 3 overrides` — and clicking it opens the same
run-controls popover that already exists (`SPEC` §5.3), scoped to that lane.
A lane's chip is the whole of its identity; nothing about a lane is implicit.

Under each reply: the per-reply stats Remuda already collects. The lane that
won on a given metric marks that number, and only that number — no aggregate
score, because "which is better" is a judgement the product should not
pretend to make.

Each lane ends with **Keep this side**, which collapses the comparison back
to a single-lane chat on that configuration and discards the other. That is
the decision the feature exists to serve, so it is a button and not a
sequence of steps.

### Scope correction from Wave 0

The single-in-flight-generation assumption is **deeper than one guard**. It is
structural, and A/B cannot be built on top of it:

- `streamRef` is a single slot, not a map (`app/src/ui/state.tsx:411`), and
  the `finally` at `:754-756` clears it unconditionally regardless of which
  stream ended.
- **The reply target is `messages[messages.length - 1]`**
  (`app/src/ui/state.tsx:704-718`). Two streams appending into one session
  would both write the same slot. Routing two streams to two targets needs an
  explicit message id, not an index-from-the-end.
- `lastStats` is one record keyed only by `sessionId`
  (`app/src/ui/state.tsx:409,724`) — two lanes would overwrite each other.
- `options` is read from `session.options` (`app/src/ui/state.tsx:700`), so
  one session cannot currently express two option sets.
- Two `RunControls` mounted at once emit **duplicate DOM ids** (`run-${key}`,
  `app/src/chat/RunControls.tsx:136,176`) and duplicate accessible labels,
  which breaks the existing `getByLabelText` tests.

So T2 splits into two waves: a **behaviour-identical send-path refactor**
(message ids, a stream map, per-target stats) that the existing test suite
must still pass unchanged, and then the A/B UI on top of it. Building the UI
against the current single-flight path would mean rewriting it twice.

### Execution — sequential, deliberately

Lane A runs to completion, then lane B. `SPEC` §8's *one streamed generation
at a time* is preserved exactly, and the reason is not just implementation
convenience: two concurrent generations against one Ollama contend for the
same VRAM, and the tok/s figures under each lane would be measuring the
contention rather than the configuration. A sequential run is the only one
whose numbers mean anything.

Lane B shows **queued** while A streams, then **warming**, then tokens.

### Rules

- **Seed is pinned for the pair, or the comparison is noise.** When neither
  lane sets `seed`, Remuda pins one shared random seed for the run and says
  so on the chip: `seed 4417 · pinned for this run`. The user can unpin it.
  Comparing two configs under two different seeds measures sampling noise
  and nothing else, and shipping that quietly would be worse than shipping
  no comparison at all.
- **Different models cost a swap, and the UI says so before the run.** If
  the lanes name different models, running them back to back unloads one and
  loads the other. A chip on the composer reads *swaps model between lanes ·
  slower first run*. Same model with different parameters is the fast path
  and the common one.
- A lane whose `num_ctx` differs from the loaded runner reloads the model —
  the existing §8 guardrail applies per lane.
- Cancel cancels the whole run, both lanes, and keeps whatever streamed.
- Compare mode is per-session state and persists with the session.

### Data model

```
ChatSession {
  …
  compare?: {
    seed: number | null       // pinned for the pair; null ⇒ each lane's own
    lanes: [LaneConfig, LaneConfig]
  }
}

LaneConfig {
  model: string
  modelfile: string | null    // variant tag, null ⇒ the base/"OG"
  options?: RunOptions
  think?: ThinkLevel
}

Message {
  …
  lane?: "a" | "b"            // absent on single-lane messages
}
```

A user message in compare mode is stored once with no `lane`; the two
assistant replies carry `lane`. Restoring an old session written before this
field exists is unaffected — `lane` is optional, and `SPEC` §6's coercion
rule already drops malformed optionals rather than discarding the session.

### Touches

`ui/state.tsx` (the send path becomes lane-aware), the chat view and
composer, `RunControls.tsx` (scoping to a lane). `api/client.ts` is
unchanged — it is already called with an options bag per request.

---

## T3 — Tool-calling playground

### What it is

A capability-gated tab where you define tool schemas, chat against them, and
see the model's `tool_calls` rendered as structured cards **validated
against the schema you wrote** — with a box to type the tool's stubbed result
and continue the conversation.

### Why it earns its place

*"Does this 8B model actually emit well-formed tool calls, or does it
hallucinate the arguments a third of the time?"* is a question every
developer evaluating a local model has, and there is currently no way to
answer it in any GUI — you write a script. Remuda already parses the `tools`
capability off `/api/show` and already gates UI on capabilities, so the
scaffolding exists.

The differentiator is the **validation verdict**, not the rendering. A chat
window that pretty-prints tool calls is a nicety. One that says *`unit`: not
in enum `[celsius, fahrenheit]`* in red is a test harness, and that is a
different product.

### Surface

A third section tab — **Chat · Modelfile · Tools** — which appears only when
the loaded model's capabilities positively list `tools`. This follows
`SPEC` §8's rule for additive controls exactly: positive evidence required,
absence degrades to the tab not existing, and the cost of a false negative
is a feature the user reaches another way.

The pane splits: tool schemas on the left (raw JSON, mono, with a
add-a-tool starter), transcript on the right.

**The tool-call card** is the surface that matters:

- function name in mono, and a **matched** / **no such tool** badge
- arguments as pretty JSON, each key badged against the schema —
  `ok`, `wrong type`, `not in enum`, `unknown key`, and required keys the
  model omitted listed separately as `missing`
- a **Respond as `get_weather`** box to type the result, which appends a
  `role: "tool"` message and continues the run

A per-session tally in the header — *7 calls · 5 valid · 2 malformed* — is
what turns a session into an answer.

### Wire

`POST /api/chat` gains `tools: [...]` in the OpenAI function schema shape
Ollama accepts. Assistant replies carry
`message.tool_calls[].function.{name, arguments}`; `arguments` is an object,
not a JSON string, on Ollama — unlike the OpenAI wire format it borrows
from, and the parser must not "helpfully" `JSON.parse` it.

Tool results go back as `{ role: "tool", content: "…" }`. Newer servers also
accept `tool_name` on that message; Remuda sends it and tolerates its
absence, since an older server ignores unknown keys.

A model that lists `tools` can still return a plain text reply to a
tool-shaped prompt — that is a finding, not an error, and the transcript
records it as **answered without calling a tool**.

### Data model

```
ToolSet {
  id, name: string
  tools: unknown[]        // raw JSON, verbatim — the user's source of truth
  parsed: ToolDef[] | null   // null ⇒ the JSON doesn't parse; shown inline
}
```

Persisted under `remuda.toolsets.v1`. Ships with two starters — a
one-required-arg `get_weather` and a two-tool set — because an empty JSON
editor is a worse first run than a wrong example.

### Touches

New tab + pane, `api/client.ts` (`tools` on the chat body, `tool_calls` off
the response), `api/types.ts`. The validator is a small hand-rolled subset of
JSON Schema — `type`, `enum`, `required`, `properties` — and deliberately not
a dependency.

---

## T4 — Fit predictor

### What it is

Before you load: a context slider in the load pane that tells you where the
model stops fitting in VRAM. *16K → 6.2 GB, fits. 32K → 9.1 GB, spills
1.4 GB to system RAM.*

### Why it earns its place

Remuda already shows the amber `100% GPU` chip when a model has spilled into
system RAM — **after** it has spilled, when the only remedy is to unload and
try again. The useful moment is the one before, and the parameter the user
would actually change is `num_ctx`, which is exactly the one that drives the
KV cache. Turning an after-the-fact readout into a before-the-fact control
is the whole feature.

### The arithmetic

`POST /api/show` returns `model_info`, keyed by architecture
(`general.architecture` → `llama`, `qwen2`, …):

```
head_dim = ${arch}.embedding_length / ${arch}.attention.head_count
kv_bytes = 2                                   // K and V
         × ${arch}.block_count
         × ${arch}.attention.head_count_kv
         × head_dim
         × ctx
         × bytes_per_element                   // f16 ⇒ 2

total ≈ weightsBytes (from /api/tags) + kv_bytes + overhead
```

Usable VRAM comes from Rust — `sysctl hw.memsize` and Ollama's own default
ceiling of roughly 75% of unified memory on Apple Silicon.

### It is an estimate, and it says so

`bytes_per_element` assumes an f16 KV cache. A user running
`OLLAMA_KV_CACHE_TYPE=q8_0` halves it, and there is no endpoint that reports
which is in force. So:

- every predicted figure is prefixed `≈` and the readout names its
  assumption in one line
- **the estimate self-corrects.** After a real load, `/api/ps` reports the
  actual `size_vram`. Remuda stores `actual / predicted` per model and folds
  it into the next prediction, so the second time you touch a model the
  number is measured rather than modelled. The readout says which it is:
  *estimated* vs *calibrated from your last load*.

An architecture whose `model_info` lacks the keys gets no prediction and no
guess — the slider renders without the fit track and says the server didn't
report enough to predict.

### Surface

A **Context** field in the load pane above **Load**. The slider track is
coloured: green to the fit ceiling, amber past it, with a tick at the
model's trained context length (`SPEC` §8's existing `num_ctx` guardrail,
now visible rather than only enforced). Green/amber are the same semantics
as the existing top-bar chip, so the two read as the same idea at two points
in time.

### Touches

New Rust command for `hw.memsize`, a pure `fit.ts` module for the
arithmetic, the load pane, and a calibration slice in state.

---

## T5 — Bench

### What it is

A saved set of prompts, replayed against the current model on one click,
with each answer diffed against the last run. The regression test for a
Modelfile.

### Why it's last

It is **T1 and T2 composed** — snapshots to run against, and a
diffed comparison to render. Built first, it would force bad versions of
both. Built after, it is mostly assembly. `SPEC` §1 lists eval harnesses as
a v1 non-goal; this is the smallest thing that is honestly useful without
becoming one.

### Surface

A second group in the chats rail — **Benches**, above **Recent**. The rail
already persists across every surface (`SPEC` §5), so a bench is reachable
from inside the Modelfile editor, which is exactly where the user is when
they want to run it.

A bench opens in the main area as a run table: one row per prompt, showing
the current answer against the previous run, with a **changed** / **same**
badge. The header names the Modelfile snapshot (T1) each run was made
against — *run 7 · against `terse-v2` @ 14:22* — which is what makes the
history and the results one artifact instead of two.

Capture is a single icon on any user message in chat: **add to bench**. A
bench that costs a form to populate does not get populated.

### Rules

- Runs are sequential and cancellable; a cancelled run keeps its completed
  rows and is marked partial rather than discarded.
- **Same/changed is a diff, not a verdict.** Remuda does not score answers
  and does not call one better. An LLM judge would make this a different and
  much less trustworthy product.
- A run pins one seed across all prompts, for the same reason T2 does.
- Deleting a bench asks, under the existing §8 confirm toggle.

### Data model

```
Bench {
  id, name: string
  model: string
  prompts: { id, text }[]
  runs: BenchRun[]          // capped; oldest evicted
}

BenchRun {
  id: string
  ranAt: datetime
  snapshotId: string | null  // the T1 Modelfile this ran against
  seed: number
  partial: boolean
  results: { promptId, content, thinking?, stats }[]
}
```

Persisted under `remuda.benches.v1`. Answers are the bulk of the payload, so
the run cap is low (8) and prose is stored trimmed.

---

## T6 — Four small ones

Each is under a day and each flatters the audience.

1. **Copy as `curl` / as `ollama run`.** An item on any assistant reply that
   yields the exact request that produced it — model, options, messages,
   `think`. It makes Remuda a place you *leave* with something, which is a
   strange thing to want a GUI to do and precisely why developers trust the
   ones that do it.
2. **Promote to `SYSTEM`.** One click on any chat message opens the
   Modelfile editor with that text staged into the `SYSTEM` field, unsaved.
   The most common thing a user does after a good reply is try to make it
   permanent, and today that is a copy, a tab switch and a paste.
3. **Regenerate with the same seed.** `seed` is already a run option. Re-roll
   a reply holding everything constant, or holding everything *but* the seed
   constant — two items, and the distinction is the entire point.
4. **Start Ollama.** The disconnected banner (`SPEC` §9) already offers
   **Start Ollama** as a button; wire it to a Rust-side spawn of `ollama
   serve` with the failure surfaced verbatim. `reqwest` and a Rust side
   already exist for the registry probe.

---

## T7 — Runtime telemetry

### What it is

The top bar's runtime readout, extended from *what the model weighs* to
*what the machine is doing* — host RAM used against total, the Ollama
process's CPU load, GPU utilisation where it can be read honestly, and the
share of the context window the current chat has actually spent.

T4 predicts fit before a load. This reports it during the run. They are the
same idea at two points in time and should read as one family.

### First, a naming collision to fix

The existing `100% GPU` chip is a **placement** figure — `size_vram / size`
off `/api/ps`, meaning *all of the weights sit on the GPU*. It is **not**
GPU utilisation. Adding a real utilisation percentage beside it would put
two chips reading `GPU` and a number next to each other, meaning entirely
different things, in the same 40 pixels.

So the placement chip is relabelled to say what it measures:

```
before   ● 100% GPU        5.6 GB VRAM · 0 B RAM
after    ● all on GPU · 5.6 GB
```

and if the model spills, `● 4.1 GB GPU + 1.5 GB RAM` in amber. Utilisation,
if it ships at all, appears only inside the popover where there is room to
label it.

### What can actually be read

| Figure | Source | Cost |
| --- | --- | --- |
| Host RAM total | `sysctl hw.memsize` | trivial |
| Host RAM used | mach `host_statistics64` / `vm_statistics64` | small |
| Ollama process CPU % | `libproc` / `sysinfo` over the `ollama` pid | small |
| Model VRAM / RAM split | `/api/ps` — already read | free |
| Context window | `/api/ps` `context_length` — already read | free |
| Context **used** | `prompt_eval_count` + `eval_count` off `/api/chat` | free |
| GPU utilisation % | **no public API — see below** | unresolved |

**GPU utilisation is not free and the spec will not pretend otherwise.** On
Apple Silicon there is no supported way to read it. `powermetrics` reports
it and requires root, which is out of the question for a Homebrew cask that
does not even sign itself. The two non-root paths — IOKit's
`AGXAccelerator` `PerformanceStatistics` dictionary, and the private
`IOReport` framework that `macmon` uses — are both undocumented and have
moved between macOS releases.

So: **GPU % is a spike, not a commitment.** Time-boxed, against the target
macOS versions, before anything in the UI promises it. The popover is
designed to render correctly without it — the row is simply absent, not
greyed, not zero, because a utilisation meter pinned at 0% is a lie a user
will act on.

### Context used is the one that matters most

`ctx 8,192` names the window. It does not change and so it carries almost no
information after the first read. What the user needs is how much of it the
conversation has spent, because the consequence of running out — silent
eviction of the oldest turns — is invisible and is the single most common
cause of *"why did it forget?"*.

Every `/api/chat` response already carries `prompt_eval_count` (the whole
prompt, system + history + this turn) and `eval_count` (the reply). Their
sum after the latest reply is the occupancy. So:

```
ctx 3,104 / 8,192          38%, green
ctx 7,740 / 8,192          94%, amber — "older turns will start dropping"
```

No new call, no tokeniser, no estimate. It is measured, and it is the
number `ollama ps` cannot give you because it is a property of the
conversation rather than the runner.

> **Wave 0: this is already half-built.** `promptEvalCount` and `evalCount`
> are already parsed (`app/src/api/client.ts:550,556`), already summed —
> `contextTokens` at `app/src/ui/state.tsx:736` — and already rendered by
> `StatsStrip` (`app/src/chat/ChatView.tsx:162-201`). T7 does not compute
> this; it reads `lastStats` off the existing context and promotes it to the
> top bar. That also means **T7 needs no `state.tsx` change at all**, which
> removes its collision with T3 in the same wave.

### Surface

> **Corrected by Wave 0 grounding.** The top bar today carries **one** chip —
> `{pct}% GPU` at `app/src/ui/TopNav.tsx:100-102`. The VRAM/RAM split, `ctx`
> and `keep_alive` readouts are **not** in the top bar; they live per-resident-
> model in the load pane's `MemorySlot` (`app/src/ui/LoadPane.tsx:85-191`).
> The "today" bar drawn in the mockup was aspirational. So T7 is *promoting*
> existing load-pane readouts into the bar, not reorganising an existing strip
> — the same destination, less demolition than assumed.

**Top bar — three chips, not seven.** Adding RAM, CPU and GPU as separate
chips makes an unreadable strip. The readout collapses to:

```
[R] [ llama3.1:8b-support ▾ ]   ● all on GPU · 5.6 GB   ctx 3,104/8,192   4:52
```

Each is a button, and all three open the same **Runtime popover**. This is
the pattern the app already uses twice — the model control opens the load
pane, the overrides pill opens run controls — so it costs the user no new
concept.

**The popover** carries the full readout:

- a **host memory bar**, segmented: this model · other processes · free,
  with `18.4 / 32 GB` beside it. The model's share as a slice of the whole
  machine is the framing that answers *can I open anything else?* — a bare
  "5.6 GB VRAM" does not.
- **VRAM / RAM split** for the loaded model, the detail behind the chip
- **CPU** — the Ollama process, as a percentage with a sparkline
- **GPU** — only if the spike lands
- **Context** — the meter, with the token counts and the eviction warning
- **keep_alive** — the existing countdown, plus **Eject**

### Rules

- **Polling stays at the existing 5s `/api/ps` cadence, and host stats ride
  the same tick.** A telemetry panel that polls faster than the data it
  displays changes is a battery drain in a menu-bar app's clothing. The
  sparkline holds 60 samples — five minutes — and nothing more.
- **Poll only when the popover is open**, for CPU and GPU. `/api/ps` is
  already on a timer for the chips; process stats are not needed until
  someone is looking at them.
- **Every figure that is unavailable is absent, never zero.** A missing
  `hw.memsize`, a server that omits `context_length`, an Ollama process that
  cannot be found — each drops its own row and says so in place. This is the
  same one-sided-gate rule as `SPEC` §8: the cost of a wrong number in a
  diagnostic panel is that the user debugs the wrong thing.
- **Context occupancy is unknown until the first reply.** Before then the
  chip shows the window alone (`ctx 8,192`), because a `0 / 8,192` on a
  chat with history already in it would be wrong.

### Data model

```
HostStats {
  memTotalBytes: number
  memUsedBytes: number
  ollamaCpuPercent: number | null
  gpuPercent: number | null       // null ⇒ unavailable on this machine
  sampledAt: datetime
}

ChatSession {
  …
  contextUsed?: number    // prompt_eval_count + eval_count of the last reply
}
```

`HostStats` is not persisted — it is a live reading and a stale one is
worse than none.

### Touches

A new Rust command returning `HostStats` (one `sysctl`, one mach call, one
process lookup), the top-bar chips, a new `ui/RuntimePopover.tsx`, and
plumbing `prompt_eval_count`/`eval_count` — already parsed for the per-reply
stats — into session state.

---

## What this does not add

No RAG, no prompt library, no personas, no cloud sync, no LLM-as-judge
scoring, no multi-user. Each of those is a chat-window feature, competes
directly with products that have years of head start, and pulls Remuda off
the one axis where it is currently alone.


---

## Build log

Updated at the end of each wave, per the working agreement.

### Wave 0 — grounding (read-only) · complete

Two `researcher` agents [opus-5] mapped the frontend state/send path and the
API/Rust layers. No files changed. Four findings that altered the plan:

1. **`state.tsx` is 1012 lines and has three shared, line-adjacent contention
   regions** — `RemudaContextValue` (`:141-259`), the `value` literal
   (`:943-989`) and its dependency array (`:990-1000`). *Every* new context
   field touches all three. Confirms the one-agent-owns-`state.tsx`-per-wave
   rule, and rules out any wave with two agents adding context fields.
2. **T2 is Large, not Medium** — see the scope correction above.
3. **T7's premise was partly wrong** — the top bar has one chip, not four; and
   context-used is already computed and rendered. Both corrected above.
4. **The Tauri shell has zero plugins today.** `src-tauri/src/main.rs` is 11
   lines with a single command registered (`:8`), and
   `src-tauri/capabilities/default.json` permits only `core:default`. There
   are no `@tauri-apps/*` npm packages — `app/src/api/registry.ts:60-76`
   reaches the bridge through `window.__TAURI__.core.invoke` deliberately.
   Whether `tauri-plugin-opener` is reachable that way, or needs its npm
   package, is **unverified** and is a spike inside Wave 1 rather than an
   assumption.

Also recorded, as a hazard for any wave touching run options: `RUN_OPTION_KEYS`
exists in **three** places with three different shapes —
`app/src/api/types.ts:170-178`, `app/src/chat/sessions.ts:100-108`,
`app/src/chat/RunControls.tsx:21-29`. Adding an option key requires all three.

**Test conventions all later waves must follow** (from `app/package.json`,
`app/vite.config.ts:7-11`): vitest 2.1.8 + @testing-library/react 16, jsdom,
tests colocated as `<Name>.test.tsx`. UI tests mount the **real**
`RemudaProvider` with an injected `FakeClient`
(`app/src/ui/test/FakeClient.ts`) and `pollIntervalMs={1_000_000}`; never a
mocking library for the client. `import "../chat/test/localStorage";` is the
first line of any test touching persistence. API tests stub `fetch` via the
`stubFetch`/`streamResponse` helpers in `app/src/api/client.test.ts:8-59`.
Gates: `npm run typecheck`, `npm test`, `npm run build` from `app/`; `cargo
fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, `cargo check
--all-targets` from `src-tauri/`.

### Wave 1 — foundations · complete, all gates green

Two `implementer` agents, disjoint file ownership.

**1A [sonnet-5] — the wire layer.** `app/src/api/{types,client,client.test}.ts`

- `chat()` takes `tools?: unknown[]` and attaches it to the request body only
  when non-empty — never `tools: []`, never `null`. Raw JSON passes through
  unvalidated; this layer does not reshape what the user authored.
- `ToolCall { name, arguments }` exported from `types.ts`; `ChatChunk` gains
  `toolCalls?: ToolCall[]`, attached only when the parsed array is non-empty.
  `toolCallsFrom` drops malformed entries rather than coercing them, and
  **never calls `JSON.parse` on `arguments`** — Ollama sends an object, not a
  string. Verified by reading the parser, not just the report.
- `ArchParams { architecture, blockCount, headCount, headCountKv,
  embeddingLength }` exported; `ModelDetail.archParams: ArchParams | null`
  populated in `show()`. **All-or-nothing**: any missing or non-numeric key
  returns `null`. A partial figure is worse than none when T4 computes a
  memory prediction from it.
- `Model`, `fetchModels` and `listGroups` deliberately untouched — T4 calls
  `show()` for the one selected model rather than widening the list path.

**1B [opus-5] — the Rust shell.** `src-tauri/**`, `app/src/api/host.{ts,test.ts}`

- `src-tauri/src/host.rs` — `host_stats()` and `start_ollama()`, built on
  `sysinfo` rather than hand-rolled FFI. Resolved `sysinfo` 0.36.1, not
  latest: the MSRV-aware resolver is bound by this crate's
  `rust-version = "1.77"` (0.38 needs 1.88, 0.39 needs 1.95).
- **CPU sampling is a delta against the previous call**, with the `System`
  held in a `OnceLock<Mutex<…>>`, rather than sleeping 200 ms inside a
  synchronous command on the main thread. Before a second sample exists it
  reports `None`, never `Some(0.0)` — and a `saw_ollama` guard stops a
  process that appeared *since* the last refresh reporting a false zero.
- `gpu_percent` is declared and **always `None`**, as specified. The field
  exists so the UI contract is stable when the spike lands.
- `start_ollama` spawns detached with `process_group(0)` under `#[cfg(unix)]`,
  so a signal aimed at Remuda does not take the server down with it. Errors
  surface verbatim.

**The opener question from Wave 0 is resolved, empirically.** The plugin route
works with **no `@tauri-apps/*` npm dependency**, preserving the posture
`app/src/api/registry.ts:60-76` already chose. Evidence: the plugin's
`build.rs` calls `global_api_script_path`, and the generated global-API script
lists `tauri-plugin-opener`'s `api-iife.js`, so `withGlobalTauri` injects it;
`host.ts` invokes `plugin:opener|open_url` straight through
`window.__TAURI__.core.invoke`. The permission identifier was confirmed by a
negative control — a deliberately bogus identifier made `cargo check` fail
with the list of accepted ones.

**The capability is scoped, not defaulted.** `capabilities/default.json` takes
`opener:allow-open-url` with an explicit `allow` list of `http://*` and
`https://*` — not `opener:default`, which would also grant `mailto:`, `tel:`,
`open_path` and `reveal_item_in_dir`. `openExternal` additionally rejects
non-http(s) schemes in TS before the bridge is reached (`file:`,
`javascript:`, `data:`, scheme-less), each covered by a test.

**One scoping error, mine.** Both agents were correctly told not to touch
`app/src/ui/test/FakeClient.ts`, so making `ModelDetail.archParams` required
left the typecheck red. Fixed in the main thread: `FakeClient` now takes an
`archParamsByTag` option so Wave 3's T4 agent can drive a fit fixture, and
`show()` returns `null` for any tag without one.

**Gates, run in the main thread, not taken on report:**
`npm run typecheck` clean · `npm test` 301 passed / 22 files · `npm run build`
ok · `cargo fmt --all --check` clean · `cargo clippy --all-targets -D
warnings` zero warnings · `cargo test` 9 passed, 3 ignored.

### Wave 2 — T1 history + two smalls · complete, all gates green

**2A [opus-5] — T1.** `app/src/ui/state.tsx`, `app/src/editor/**`

- `app/src/editor/history.ts` — `remuda.modelfile-history.v1`, per-tag ring
  capped at 40 with a 400 global cap, oldest-first eviction that never takes a
  tag's last snapshot. Content-addressed via FNV-1a, no dependency. Two-tier
  coercion copied from `sessions.ts`: bad `id`/`tag`/`rawText`/`savedAt` drops
  the record, a bad `kind` degrades to `"save"` and the record survives.
- `app/src/editor/diff.ts` — pure LCS line diff plus the `+4 −1 · SYSTEM,
  temperature` summary. Falls back to whole-file replace above 1500 lines.
- `app/src/editor/HistoryView.tsx` — timeline left, unified diff right,
  `Restore this` in the diff bar, `current` badge, and the `edited outside
  Remuda` drift entry.
- The snapshot is written **inside the try, immediately after the
  `client.create` loop completes** — a failed create records nothing.

**Restore never creates — verified in the main thread, not taken on report.**
`restoreSnapshot` is pure local state: it parses the snapshot into the draft,
sets `dirty`, bumps an `externalEdit` counter to resync the raw pane, and
switches to Raw. It makes no client call of any kind. The test asserts
`createCalls`, `unloadCalls` **and** `loadCalls` are all empty and that no
history entry is written; a companion test proves the *subsequent* Save is
what creates, records `kind: "restore"`, and parents on the restored id.

**Context surface later waves code against** (`RemudaContextValue`):
```ts
modelfileHistory: ModelfileSnapshot[];
historyForTag: (tag: string | null) => ModelfileSnapshot[];
editorPane: EditorPane;                  // "form" | "raw" | "history"
setEditorPane: (pane: EditorPane) => void;
restoreSnapshot: (id: string) => void;
promoteToSystem: (text: string) => Promise<void>;
```
`promoteToSystem` is exported and deliberately **not wired to any chat UI** —
Wave 3b owns `ChatView` and attaches the entry point there.

**Accepted deviation.** There was no existing Form/Raw toggle to extend:
`EditorView` renders both columns side by side, which SPEC §5.4 mandates. So
**History** is the only exclusive pane; Form/Raw reweight the split
(`1.25fr/0.75fr`) and only become exclusive below 900px. Making Form/Raw fully
exclusive would contradict §5.4 and break three existing tests. The agent
flagged this rather than deciding unilaterally, which was the right call, and
the conservative reading stands.

Not implemented, and deliberately: `savePath` on the snapshot (nothing in the
save path knows a path today — this is SPEC §12 question 4, still open), and
the `Copy` button the mockup draws in the diff bar.

**2B [sonnet-5] — two smalls.** `app/src/chat/exportRequest.ts`,
`app/src/ui/OfflineBanner.tsx`

- `asCurl` / `asOllamaRun`, pure, driven by `RUN_OPTION_KEYS` from `types.ts`.
  POSIX `'\''` escaping so a prompt containing an apostrophe still pastes.
  `asOllamaRun` **annotates what it cannot reproduce** with `#` comments —
  `think`, embedded images, multi-turn history — rather than dropping them
  silently. A wrong command would be worse than an annotated one.
- Start Ollama wired to `startOllama()`, spawn failures surfaced **verbatim**,
  a re-entry guard so a double-click cannot spawn twice, and the
  outside-the-shell rejection caught so no unhandled rejection escapes.

One honest limit: `wireOptions`/`wireThink`/`wireMessage` are unexported in
`client.ts`, so `exportRequest.ts` **mirrors** them rather than importing.
That is a drift risk worth a follow-up — the right fix is exporting the three
encoders from `client.ts` and having both call sites share them.

**Gates, run in the main thread:** `npm run typecheck` clean · `npm test`
**353 passed / 26 files** · `npm run build` ok.

Not yet visually verified in the running app — the History pane needs a loaded
model to reach, so it is asserted by component tests and the mockup for now.
Worth a live pass once Wave 4's UI lands.

### Wave 3 — send-path refactor + T4 · complete, all gates green

**3A [opus-5] — the multi-stream seam.** Behaviour-identical by construction:
`app/src/chat/ChatView.tsx` is provably untouched (`git status --porcelain`
empty) and all 353 prior tests pass unmodified.

- `Message extends ChatMessage { id?: string }` in `sessions.ts` — the agent
  correctly refused to add it to `ChatMessage` in `api/types.ts`, which is
  outside its scope.
- **Append is by message id, and a miss is a no-op returning the previous
  state** — never a fallback to "the last one", which would reintroduce the
  exact bug being removed.
- `streamRef` → `streamsRef: Map<targetMessageId, {controller, sessionId}>`.
  Each run's `finally` removes only its own entry. `streamingSessionId` is
  derived, so its observable value is unchanged.
- `runGeneration(args)` extracted — takes everything through `args`, reads
  nothing from the closure. **This is the seam the A/B wave calls twice.**

```ts
runGeneration: (args: RunGenerationArgs) => Promise<void>;
interface RunGenerationArgs {
  sessionId: string; targetMessageId: string; model: string;
  messages: ChatMessage[]; options?: RunOptions; think?: ThinkLevel;
  signal: AbortSignal;
}
```
It chains its own `AbortController` to the incoming signal, so a pair-wide
signal cancels both lanes while `cancelGeneration()` can still reach one.

The §8 one-at-a-time guard was **deliberately left in place** — this wave
makes concurrency possible, the A/B wave decides when to allow it.

The agent **mutation-tested its own regression guards** rather than trusting
green: reverting the append to `messages[length-1]` fails 3 tests, changing
`delete` to `clear` fails the deleteSession test. That is the right standard.

**Open item carried forward.** Message ids are **not persisted** —
`forStorage` strips them, because `ChatView.test.tsx:150,351` assert `toEqual`
on the stored message shape. Harmless today, but T2 needs `lane` to survive a
restart per this spec's data model, so the A/B wave must persist both `id` and
`lane` and deliberately update those two assertions.

**3B [sonnet-5] — T4.** `app/src/models/fit.ts`, `fitCalibration.ts`,
`app/src/ui/LoadPane.*`

- Closed-form fit ceiling, no loop. `APPLE_SILICON_VRAM_FRACTION = 0.75`
  named and documented as Ollama's heuristic, not a measured limit.
- `RUNTIME_OVERHEAD_BYTES = 0`, deliberately: no endpoint reports it, and
  calibration folds in the real gap rather than double-counting a guess.
- Calibration in its own module and key (`remuda.fit-calibration.v1`), ratios
  clamped to [0.5, 2.0], zero/negative observations ignored, and recorded
  **only when the model loaded fully on GPU** — a spilled load is not a clean
  calibration point.
- Cannot-predict is a typed result carrying **no number**, rendered as the
  third state with no track, no tick and a sentence naming what was missing.
- Arithmetic validated against a hand-computed llama-8B fixture: head_dim 128,
  131,072 B/token, at ctx 16,384 → kv 2,147,483,648 B, total 7,047,483,648 B.

**Integration I did myself in the main thread.** 3B correctly stopped at its
scope boundary rather than reaching into `api/**` and `state.tsx`, which left
the slider predicting but not applying — misleading UI. So `numCtx` is now
threaded end to end: `types.ts` `load(tag, keepAlive, signal?, numCtx?)`,
`client.ts` sending `options: { num_ctx }` on `/api/generate`, `state.tsx`
`load(tag, numCtx?)`, and `LoadPane` lifting the chosen value out of
`FitPanel`.

**The slider sends nothing until the user actually moves it.** Defaulting a
`num_ctx` onto every load would silently override a Modelfile's own
`PARAMETER num_ctx` — the predictor changing the thing it claims only to
predict. Choosing a different model clears the previous choice. Covered by
five new tests, including `client.load` which had **no coverage at all**
before this change.

**Gates:** `npm run typecheck` clean · `npm test` **400 passed / 28 files** ·
`npm run build` ok.

### Wave 4 — T2 A/B UI + T7 telemetry · complete, all gates green

**4A [opus-5] — T2.** `ChatView`, `RunControls`, `sessions.ts`, `state.tsx`,
new `compare.ts` and `ReplyMenu.tsx`.

- `sendCompare` appends the user message **once with no lane**, then runs
  `for (const lane of LANES) { … await runGeneration(…) }` on one pair-wide
  `AbortController`. Sequential, as specified.
- `statsByMessage` replaces the single `lastStats` slot for compare runs —
  two lanes cannot share one record.
- `RunControls` takes a `scope` prop: ids become `run-lane-a-temperature` and
  the scoped name moves to `aria-label`, so the **visible** label stays
  "Temperature" and unscoped instances render byte-for-byte as before. That
  was the duplicate-id blocker from Wave 0.
- `forStorage` now strips only `images` — `id` and `lane` persist, closing
  the open item Wave 3 carried forward.

**Sequential execution is mutation-tested, not merely green.** Replacing the
`for … await` with `Promise.all` fails **8 tests**; ignoring the seed pin
fails 2; making `historyForLane` return everything fails the per-lane
continuation test — which the agent added *because* its first suite missed
that mutation.

**Three assertions changed, all reported.** Two `ChatView.test.tsx` stored-
shape assertions gained the now-persisted `id` (still exact-shape — an extra
field still fails). One `sessions.test.ts` test was **inverted**: "never
writes message ids to storage" became "writes message ids — a lane reply is
unreadable without one". That test encoded exactly the behaviour T2 requires
reversing.

Deliberate departures from the mockup, with reasons: the interactive lane
config chip lives in the compare bar rather than the lane head, because a chip
on an older turn would label old output with today's settings (per-turn config
is not recorded) and duplicate accessible names; and "Regenerate · same seed"
is **disabled when no seed is set** rather than inventing one.

**4B [sonnet-5] — T7.** `TopNav`, new `RuntimePopover` and `useHostStats`.

- `100% GPU` is gone from the top bar: `all on GPU · 5.6 GB` when resident,
  `28.4 GB GPU + 9.1 GB RAM` in amber when spilled.
- Three chips, each opening one popover. Context reads `lastStats` **gated on
  `lastStats.sessionId === activeSessionId`**, so a stale session's number
  never leaks; the window alone shows before the first reply.
- The "poll only while open" rule is enforced **structurally** — the hook has
  no open flag; the popover is only mounted while open, so mount/unmount is
  the gate. Proven three ways: the bridge is never invoked while closed, is
  invoked on open, and stops after unmount across a 5s timer advance.
- Absent-never-zero holds: with no bridge the host-memory, CPU and GPU rows
  do not render at all, and that is the default path in every test.

**Two things I fixed in the main thread.**

1. **A genuine flake, not dismissed.** `LoadPane > shows tuned and loaded
   together` failed once in four full runs. It asserted synchronously after a
   click, but T4's `FitPanel` now has async effects (`client.show`,
   `hostStats`) in flight that can re-render during the step-back. Switched to
   `findBy`; stable across four further full runs.
2. **The relabel was half-done.** T7 fixed the top bar, but the load pane tray
   still read `62% GPU` for the same figure — reintroducing the exact
   utilisation/placement ambiguity the relabel existed to remove. Both load-pane
   sites now read `62% on GPU`, which cannot be misread, and keeps the number
   the split bar illustrates.

**Gates:** `npm run typecheck` clean · `npm test` **444 passed / 32 files**,
stable across repeated runs · `npm run build` ok.

### Wave 5 — T3 tool playground + T8 docs · complete, all gates green

**5A [opus-5] — T3.** New `app/src/tools/`, plus three surgical edits
(`App.tsx`, `ViewTabs.tsx`, and **exactly one line** of `state.tsx:50` for the
`View` union — verified by grep).

- `validate.ts` — the hand-rolled JSON-Schema subset, no dependency. Type
  before enum; `integer` distinct from `number` (and satisfies it, not the
  reverse); `null` and arrays are not objects; a `type` keyword the subset
  does not implement is **not judged** rather than failed.
- An unmatched call returns no per-key verdicts at all — no schema matched, so
  claiming per-key judgements would be invention. The card prints the raw
  arguments unbadged under the `no such tool` badge.
- `ToolSet` stores the **raw text**, not the parsed array, so a half-typed
  schema persists verbatim instead of being discarded.
- The gate is one-sided: `[]` → no tab, other capabilities without `tools` →
  no tab, `tools` present → tab. All three cases tested.
- The transcript lives in local `useState`, not `ChatSession` — it is a
  playground, nothing shows in the chats rail, and that is what kept
  `state.tsx` to one line. Tool *sets*, the part worth keeping, persist.

**5B [sonnet-5] — T8.** New `site/`, `.github/workflows/pages.yml`,
`Settings.tsx`.

- Six cross-linked static pages under **`site/`, not `docs/`** — publishing
  `docs/` would put these internal specs and mockups on the public web. No
  build toolchain; tokens copied from `docs/mockup.html`. Rendered and read in
  the main thread: correct identity, correct voice.
- Content grounded in this build log rather than the aspiration — Bench is not
  documented, and GPU utilisation is documented as **unavailable**.
- Settings gains a Documentation section using `openExternal`, **never a bare
  `<a href>`**, which would navigate the webview and trap the user in the app
  with no back button. The rejection outside the desktop shell is caught and
  surfaced inline.

**A functional gap I closed in the main thread.** 5A correctly refused to edit
`api/**` and flagged that the assistant's own `tool_calls` were not echoed back
into the outbound history. That is a real bug, not a nicety: the server would
receive a `role: "tool"` message answering a call it never saw, and the turn
reads as a non-sequitur to the model. So:

- `ChatMessage.role` widened with `"tool"` — a real wire role, removing 5A's
  documented cast — plus optional `toolCalls` and `toolName`.
- `wireMessage` **re-encodes** rather than passes through: the domain shape is
  `{ name, arguments }`, Ollama's is `{ function: { name, arguments } }`.
  `tool_name` is always safe to send; older servers ignore unknown keys.
- One `ToolsView` assertion updated to the new exact shape (not loosened), and
  two new `client.test.ts` cases prove both the encoding and that an ordinary
  turn is byte-unchanged.

**Action required of the repo owner:** GitHub Pages must be enabled manually —
Settings → Pages → Source: **GitHub Actions** — before `pages.yml` can
publish. A workflow cannot enable Pages for itself.

**Gates:** `npm run typecheck` clean · `npm test` **498 passed / 35 files** ·
`npm run build` ok · `cargo clippy -D warnings` zero · `cargo test` 9 passed.

### Wave 6 — independent verification · complete

A `verifier` [opus-5] re-derived correctness across the whole branch without
trusting any prior wave's report. It confirmed all eight load-bearing rules by
reading implementations rather than tests, ran the suite five times with no
flakes, and found **six real defects**. All six are now fixed.

**1. The fit calibration corrected almost nothing, then claimed it had.**
The worst of the six, and exactly the kind of dishonesty T4 was written to
avoid. `LoadPane` recorded a **whole-runner** ratio (`actual / predictedTotal`)
while `fit.ts` applies the factor to the **KV term alone**. Since weights are
~82% of the total, a 13% error was reduced to 10.7% — and the readout then
said *"Calibrated from your last load"*.

Fixed by recording the KV-only ratio the maths actually wants:
`(actualVram − weights) / predictedKv`. The sanity band widened from
[0.5, 2.0] to [0.25, 4.0] accordingly — a band tuned for a whole-runner ratio
would have started silently rejecting valid KV observations.

The verifier also noted **no test crossed that seam**: one module proved KV
alone is scaled, the other proved the ratio round-trips through storage, and
nothing asserted that a recorded observation makes the next prediction
reproduce it. New `app/src/models/fitRoundTrip.test.ts` asserts exactly that,
and would have caught the bug.

One test fixture was rewritten rather than patched: it had been passing on a
**bogus calibration**. `FakeClient` reports `sizeVramBytes === sizeBytes` — a
runner holding zero KV cache — which the corrected arithmetic rightly rejects
as not an observation at all. The fixture now pins a realistic residency.

**2. `exportRequest.ts`'s mirror of `wireMessage` had drifted** — it lacked
the `tool_calls`/`tool_name` encoding added in Wave 5. Latent (no tool-carrying
message reaches a chat session today) but the type system already permits it.
Mirror updated. The underlying fix remains exporting the three encoders from
`client.ts`; the drift risk is real and now documented twice.

**3. `predictFit` fabricated a figure when the model's size was unknown.**
It guarded `archParams` and VRAM but not `weightsBytes`, and `client.ts` floors
a missing `/api/tags` size to `0` — so a model with no reported size rendered
*"✓ Fits entirely on GPU"* with `0 MB weights`, wrong by the size of the model.
Now a first-class cannot-predict result.

**4. Widening `ChatMessage.role` opened a whole-session data-loss path.**
`sessions.ts` still rejected `"tool"`, and a rejected role escalates to
dropping the **entire session**. Not reachable today (the playground keeps its
transcript in local state) but a trap set for the next wave. `"tool"` is now
accepted, with a comment naming the escalation.

**5. The context slider's floor could exceed a model's trained ceiling.**
For any model with a trained context ≤ 512 — embedding models, which the load
pane does let you select — `max < min`, giving a `NaN%` track width and
letting one drag pin a `num_ctx` **above** the trained maximum, inverting the
clamp's purpose. Both bounds now clamp.

**6. Tools: Send stayed enabled with an empty schema.** The guard covered
unparseable JSON but not a schema that parsed to zero tools — so the request
omitted `tools` entirely and the reply was reported under *"answered without
calling a tool"*: a finding about the model, when nothing had been offered to
it. Both `send` and `respond` now guard.

**Also fixed: the verifier's one open suspicion.** It could not confirm whether
`Command::new("ollama")` resolves in a Finder-launched bundle. It does not —
such a bundle inherits launchd's minimal `PATH`, so a Homebrew `ollama` at
`/opt/homebrew/bin` is invisible and **Start Ollama would fail for most
users**. `host.rs` now probes the bare name first (so a working `PATH` still
wins) then known install locations, and falls back to the bare name so the
error the user sees is the real one rather than one about a guessed path.

**Confirmed sound by the verifier**, listed so the coverage is legible: the
`value` memo dep list (61 keys diffed mechanically; one omission, an
identity-stable `useState` setter); every new timer and `AbortController`
cleaned up; all three new stores bounded; `remuda.sessions.v1` still
round-trips payloads written by an older build; the scoped
`opener:allow-open-url` capability; and all `site/` links resolving.

**Final gates:** `npm run typecheck` clean · `npm test` **501 passed / 36
files**, stable across three consecutive runs · `npm run build` ok ·
`cargo fmt --check` clean · `cargo clippy -D warnings` zero · `cargo test`
9 passed, 3 ignored.

### Post-review · two blockers fixed, then tested against a live server

**The two review blockers.**

1. **Per-lane errors.** `streamError` was one app-wide slot that lane B cleared
   on entry, discarding lane A's failure. Added `errorsByMessage`, keyed by the
   assistant message; the app-wide slot is now cleared only when no sibling run
   is in flight, and each lane renders its own error. **Mutation-tested**: the
   new test fails against the pre-fix code and passes after.
2. **`pages.yml`** — `cancel-in-progress: false`, per GitHub's own guidance for
   Pages deployments; cancelling an in-flight deploy registers as a failure
   rather than a supersede.

**Then: built via `scripts/build-and-install.sh --debug` and run against a real
Ollama 0.32.15 with a 27B model on a 52 GB Mac.** (There is no `build-dmg.sh`
in this repo.) Three defects that only real hardware could surface:

**A. The KV formula was wrong for any architecture that declares its head
dimensions.** `head_dim` was derived as `embeddingLength / headCount`, which
for qwen35 gives **5120 / 24 = 213.33** — a fractional head dimension, and the
giveaway. The server declares `attention.key_length` and `.value_length` (256)
outright. Generalised to
`blockCount × headCountKv × (key_dim + value_dim) × bytesPerElement`, which
reduces to the old formula when the dims are equal and derived. Gemma also
declares these. Fixed, with a test built from the real `/api/show` payload.

**B. The sanity band rejected the first real observation.** Predicted 26.28 GB
at ctx 32,768; Ollama actually reported **19.70 GB** — an implied KV factor of
**0.245**, which fell below the 0.25 floor and would have been discarded as an
outlier. The model whose estimate was furthest out was the one that could never
calibrate. Floor lowered to 0.1, with the measurement recorded in the code as
the justification.

**C. The f16 assumption is an upper bound, not an estimate.** The same
measurement shows modern Ollama using roughly a quarter of the predicted KV —
it quantises the cache and does not necessarily allocate the whole window up
front. The existing "Estimated · assumes an f16 KV cache · load once to
calibrate" copy is accurate, and now demonstrably load-bearing.

**A limitation worth knowing, not a defect.** `gemma4` reports **no
`attention.head_count_kv`**, so `archParamsFrom` returns `null` and the fit
predictor shows *No prediction available* for Gemma models — 1 of the 2 model
families installed on the test machine. Defaulting it to `head_count` per the
GGUF convention would produce a number, but an unverified one that could be 8x
high, so the honest no-prediction state stands.

**Validated live, end to end:** model list and grouping · capability chips ·
load · the three top-bar chips with the relabelled `all on GPU · 19.7 GB` ·
**`ctx 402/32,768` after the first reply** · the Runtime popover correctly
omitting host/CPU/GPU rows with no bridge · streaming chat with reasoning
folded away · the per-reply stats strip · the Tools tab appearing on a
`tools`-capable model · **A/B compare running lanes sequentially with lane B
queued, a pinned seed producing byte-identical 197-token replies, and both
lanes' four metrics in matching grid positions.**

**Confirmed as a real user-visible issue:** review finding #3 — the runtime
chips open the popover but never toggle it, so it sat overlapping the chat
with no way to dismiss it from the chip. Not yet fixed.

Not verified: the packaged app's own window (this environment lacks Screen
Recording permission), so the Tauri-only paths — `host_stats`, `openExternal`,
`start_ollama` — remain untested outside their unit tests.

**Final gates:** `npm run typecheck` clean · `npm test` **506 passed / 36
files** · `npm run build` ok · `cargo clippy -D warnings` zero.
