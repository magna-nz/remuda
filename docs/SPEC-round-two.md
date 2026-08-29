# Remuda — round two

> Six features drawn from the parts of Ollama's API Remuda never touched, plus
> the help layer that makes any of them findable. The visual reference is
> [`mockup-proposals-2.html`](mockup-proposals-2.html) — every surface named
> here maps to a section in it.

**Relationship to the other specs.** `SPEC.md` is the product. `SPEC-tuning.md`
is the tuning loop (T1–T7) and already contains **T5 — Bench**; R4 below is that
spec, built, not a second design. Nothing here supersedes either document.

**What this round does not add.** No cloud models, no `ollama signin`, no
`/api/push`, no web-search tools. All four need an account or an API key, and
Remuda's promise is that nothing leaves `127.0.0.1`. Recorded so they are not
re-proposed.

---

## R1 — Load-time `num_gpu`

### What it is

A layer-offload control in the load pane, sent as `options.num_gpu` on the load
call.

### Why it earns its place

The fit predictor already computes that a model at a given context will spill
into system RAM, and `LoadPane.tsx` already prints *"N is running on the CPU.
Expect a large drop in tok/s."* The only action offered is **Eject**. `num_gpu`
caps how many transformer layers go to the GPU, so the warning gains a response
other than giving up.

### Rules

- **Load-time, not sampling.** Like `num_ctx`, it sizes what the runner
  allocates, so it can only be set as the model loads. It belongs in the load
  pane, *not* in the per-chat run controls.
- Omitted from the request body entirely when unset — never sent as `0`, which
  means "no layers on the GPU" and is a real, different instruction.
- `exportRequest.ts` mirrors the wire mapping by hand and must be updated in
  the same change, or "Copy as curl" silently drifts from what was sent.

### Touches

`api/types.ts` (`RunOptions.numGpu`, `RUN_OPTION_KEYS`, `load()` signature),
`api/client.ts` (`load()`), `ui/LoadPane.tsx`, `chat/exportRequest.ts`.

---

## R2 — Constrained output (`format`)

### What it is

A per-chat JSON Schema sent as `format` on `/api/chat`. Ollama constrains
decoding to it, so a reply that does not fit the schema is unreachable rather
than unlikely.

### Why it earns its place

Half of Modelfile tuning is trying to make a model emit a shape by asking
nicely in `SYSTEM`, then watching it drift. `format` deletes that whole class of
system prompt, and moves the question from "is this valid JSON" to "are the
values any good". The JSON-Schema validator (`tools/validate.ts`) and the
field-by-field verdict card (`tools/ToolsView.tsx`) already exist — this is that
pair pointed at the reply instead of the tool call.

### Surface

A **Format** pane beside the chat, opened from a pill in the composer's note
bar next to Run controls. Three states: `Schema`, `json` (Ollama's older
`format:"json"` — valid JSON, no shape), and `off`. Each reply gets a
conformance card under it.

### Rules

- **Per-chat, never persisted to a Modelfile.** There is no `PARAMETER format`,
  so there is nothing to bake and the pane must not offer to.
- `off` omits `format` from the body entirely. It is not sent as `""`.
- A schema that does not parse is a **local** error shown in the pane; the send
  is refused rather than made without the constraint the user asked for.
- **Truncation is reported as truncation.** Under `format` the model cannot
  emit invalid JSON, but it *can* be cut off when `num_predict` runs out. The
  card must name that cause rather than showing a parse error — it is the most
  common way constrained output fails.
- Verdicts are recomputed on render, never stored, exactly as T3 does.

### Touches

New `app/src/format/`. `chat/ChatView.tsx`, `ui/state.tsx`, `chat/sessions.ts`
(persisted per session), `api/types.ts` + `api/client.ts` (the `format` field),
`chat/exportRequest.ts`.

---

## R3 — The rendered prompt

### What it is

A fourth segment in the Modelfile editor — `Form · Raw · Prompt · History` —
showing the model's `TEMPLATE` beside that template rendered with the current
chat's content substituted.

### Why it earns its place

Remuda is a Modelfile tuning tool that never shows the string the model
receives. When a system prompt appears to be ignored there is no way to
distinguish "the model ignored it" from "it never arrived" — and a template
that does not reference `.System` drops it silently. That bug is invisible from
the chat window and obvious here.

### Rules

- The template comes from `/api/show`, which Remuda already calls and stores in
  `ModelDetail.template`. No new request.
- **The renderer is a documented subset**, not a Go `text/template`
  implementation: `if`, `range`, `.System`, `.Prompt`, `.Messages`, `.Role`,
  `.Content`, `.Tools`. Anything outside it renders as *"unsupported template
  action — showing the raw template"* rather than a guess. A wrong render is
  worse than an absent one.
- The left footer carries the check that is the point of the pane: **references
  `.System`**, red when the template cannot see the system prompt.
- **Send as raw…** posts the rendered text back through `/api/generate` with
  `raw: true`, bypassing templating. If raw and normal sends agree, the render
  was right — the pane's own test.

### Touches

New `app/src/editor/prompt/` (pure renderer + tests). `editor/EditorView.tsx`,
`editor/ViewTabs.tsx`. Must not touch `ui/state.tsx`.

---

## R4 — Bench

Built to `SPEC-tuning.md` **T5**, which stands as written: the surface, the data
model, the persistence key and the run cap of 8 all come from there. Two points
restated because they are the ones easiest to get wrong:

- **Same/changed is a diff, not a verdict.** No scoring, no LLM judge.
- One seed pinned across every prompt in a run, for the reason T2 pins one.

Added by this round:

- An **errored row is a real result** and stays visible with its cause — a
  context-length failure is exactly the kind of thing a bench exists to surface.
- Rows are collapsed by default and sorted **changed first**.
- The empty state carries R5's layer 1 (below) — it is where "what is a bench"
  is answered.

### Touches

New `app/src/bench/`. `ui/Sidebar.tsx` (the Benches rail group),
`chat/ReplyMenu.tsx` (capture), `ui/state.tsx`.

---

## R5 — Help, in three layers

None of them modal, and **a tour is not one of them** — a tour watched once
cannot answer a question asked later.

### Layer 1 — the empty state

Every feature's first screen is empty by definition. An empty screen that
explains what the feature is, why you would use it, and the three steps to
start costs nothing to find. This is where "what does *bench* mean" is
answered.

### Layer 2 — `<PaneHelp>`, one `?` per surface

A `?` in each pane header toggling an explainer **inline** — it pushes the pane
down rather than floating over it, so it cannot cover what it describes and a
stray click cannot dismiss it. Always the same three beats: what it is, why
you'd use it, how. Open/closed persists per pane.

### Layer 3 — `<Term>`, a glossary for the machine words

`SPEC.md` §4 already splits human words (Inter) from machine words (Plex Mono).
Layer 3 makes every machine word a definition: dotted underline, opening on
hover **and focus and click** — never hover-only, which is unreachable by
keyboard and invisible on touch. One component, one flat glossary, every
surface.

### Rules

- Dismissal state is per-pane and persisted; **Settings → Reopen all** clears
  every dismissal at once, because remembering is right for the owner and wrong
  for whoever they hand the laptop to.
- Help copy names things the way a user would, never the way the code does.

### Touches

New `app/src/help/`. Pane headers across `bench/`, `format/`, `editor/`,
`tools/`, `chat/`. `ui/Settings.tsx`.

---

## R6 — The guided tour

Five steps: the model control, the Modelfile editor, Bench, Format, Prompt.

### Rules

- **Offered, never forced** — a dismissible card, not a modal standing between
  the user and the app they just installed.
- Runs on the **real** UI through a step registry; elements register a ref by
  step id. A step whose target is absent is **skipped**, never wedged.
- **It must survive Ollama not being installed**, which is the likeliest state
  on a first launch. No step may require a loaded model.
- Five steps. Nobody finishes fifteen.
- Re-runnable from **Settings → Help**, alongside *Reopen all* and the
  glossary.
- Keyboard: `←`/`→` move, `Esc` leaves, focus is trapped in the step card, and
  `prefers-reduced-motion` is honoured.

### Touches

New `app/src/tour/`. `ui/Settings.tsx`, `App.tsx`, and a ref registration in
each targeted component.

---

## Build log

Updated at the end of each wave, per the working agreement.

### Wave 1 — R1 `num_gpu` + R5 layers 2/3 · complete, all gates green

**1A [sonnet-5] — R1.** `api/types.ts`, `api/client.ts`, `ui/LoadPane.tsx`
(+`.css`), `ui/test/FakeClient.ts`.

- `numGpu` added to `RunOptions` and `RUN_OPTION_KEYS`; `load()` widened.
  Unset is omitted; `0` is sent, because "no layers on the GPU" is a real
  instruction and not the same as "you decide".
- The control hides entirely when `archParams` is null — no known
  `blockCount` means no honest ceiling to offer, the same principle the fit
  predictor already follows by staying silent rather than guessing.
- `exportRequest.ts` needed no functional change: it maps over the shared
  `RUN_OPTION_KEYS`, so `num_gpu` flows through in lockstep. Covered by test
  rather than assumed.

**1B [opus-5] — R5 layers 2 and 3.** New `app/src/help/`, no existing file
touched.

- `PaneHelp` renders in normal flow (`<section role="region">`, no `position`
  in its CSS) with a test asserting it precedes the pane body in document
  order — the constraint that keeps it from covering what it describes.
- `Term`'s trigger is a real `<button>`, so click and keyboard focus both
  reach it for free; hover is layered on top.
- Dismissal persists under `remuda.help.v1` behind a defensive parse; six
  corrupt-payload cases are tested. A change-listener set keeps the header
  `?`, the strip's `✕` and Settings → *Reopen all* in step without
  prop-drilling.

**Two things fixed in the main thread, both cross-boundary by nature.**

1. **`Term` closed on the first click.** The tests fired `click` alone, which
   in jsdom fires neither `mouseEnter` nor `focus`. A real mouse fires all
   three in order — and because `onFocus` also *pinned*, the click that
   followed read as a second click and closed the popover it had just
   opened. Focus now opens without pinning; keyboard focus needs no pin,
   since it holds the popover for exactly as long as it lasts. Two tests were
   added that fire the full sequence, and both were confirmed to fail against
   the old code before the fix went in.

2. **`RunControls.tsx` typed three maps as `Record<keyof RunOptions, …>`.**
   Adding any domain-wide run option therefore demanded a popover label and
   an "inherited" fallback for it — meaningless for a load-time parameter.
   The maps are now keyed on `PresentedKey`, the popover's own curated list,
   which is what they were always indexed by. 1A had correctly refused to
   touch the file and reported the conflict instead of widening its own
   scope.
   1A had also inlined `client.load(...)` inside `LoadPane` to avoid editing
   `state.tsx`; the store's `load` is now widened to carry `numGpu` and the
   pane routes through it again.

**Gates:** `npm run typecheck`, `npm test` (566 passed, 40 files),
`npm run build` — all clean. Pushed to the draft PR for the macOS and Linux
legs.

### Wave 2 — R2 `format` + R3 rendered prompt · complete, all gates green

**2A [opus-5] — R2.** New `app/src/format/`, plus `api/{types,client}.ts`,
`chat/{ChatView,sessions,exportRequest}.ts(x)`, `ui/state.tsx`.

- `tools/validate.ts` is **reused, not forked**: the reply body is handed to
  `validateCall` as a call's arguments with the schema as its parameters, so
  the type/enum/required rules and the note strings are literally the tool
  card's.
- Truncation is detected **structurally** — `scanJson` asks whether the text
  is a *prefix* of valid JSON. Under `format` that is exactly truncation, and
  it needs no `done_reason`, so `api/` stayed at "the `format` field only".
- An unparseable schema **refuses the send** rather than quietly sending an
  unconstrained request.
- `format` is per-chat and offers no bake-into-Modelfile path, because there
  is no `PARAMETER format` to bake it into.

**2B [opus-5] — R3.** New `app/src/editor/prompt/`, plus `editor/EditorView`.

- `render.ts` is pure and total: 46 tests, no throw on any input, and an
  action outside the subset returns a failure naming it rather than a partial
  render.
- The template is read from the **draft**, not `ModelDetail.template` — the
  store parses `detail.modelfile` and discards the detail, and reading the
  draft means editing `TEMPLATE` in the Raw pane updates the render live.
- **Send as raw…** deferred: it needs `api/` and `state.tsx`, both owned by
  2A this wave. TODO sits at its call site.

**Three things fixed in the main thread. Two were false alarms on the one
indicator this pane exists for**, both found by pointing the app at a live
Ollama 0.32.15 rather than by reading the code.

1. **Jinja templates.** Newer models ship the Jinja chat template embedded in
   their GGUF instead of a Go `text/template` — four of the six models on the
   development machine do. Jinja reaches the system prompt through its
   `messages` array and never writes `.System`, so the footer read *"your
   system prompt never reaches the model"* on every one of them. `analyse.ts`
   now reports a `dialect`, and the indicator is **absent** for Jinja rather
   than red. Fixture taken verbatim from the live server.
2. **`RENDERER`.** gemma-4 declares `RENDERER gemma4` and ships
   `TEMPLATE {{ .Prompt }}` as a stub: Ollama assembles the real prompt
   natively. The template renders *cleanly*, so this could not be caught by
   the failure path — the pane showed a plausible rendered prompt that was a
   fraction of the truth, under a red `.System` flag. `declaredRenderer()`
   now suppresses the indicator and puts a banner above the rendered output
   saying it is not what the model receives.
3. **The conformance card judged replies written before the schema existed.**
   Switching a schema on put a red "not valid JSON" verdict under older
   prose. `Message.constrained` records the constraint at generation time, so
   only replies actually decoded under a schema are judged.

Also: `EditorPane` gained `"prompt"` as a real member rather than the local
`useState` 2B was forced into, because R6's tour step has to be able to open
that pane the same way the segment buttons do.

**Verified live**, against Ollama 0.32.15 with `gemma-4-31b` loaded: a
constrained send returned conforming JSON and the card read *Conforms — 3 of
4 properties · 2 of 2 required present*, badging `summary` string, `severity`
enum, `breaking` boolean.

**Gates:** `npm run typecheck`, `npm test` (696 passed, 46 files),
`npm run build` — all clean.

### Wave 3 — R4 Bench + R5 layer 1 and wiring · complete, all gates green

**3A [opus-5] — R4.** New `app/src/bench/`, plus `ui/Sidebar.tsx`,
`chat/ReplyMenu.tsx`, `ui/state.tsx`.

- `words.ts` **reuses `editor/diff.ts`** rather than writing a second LCS:
  words are fed to `diffLines` one per line and the returned indices look the
  original whitespace back up.
- `run.ts` takes a `BenchChat` callback, not a client, so all four run rules
  are testable without a server or a render.
- `ReplyMenu`'s items are now individually optional, so one component serves
  an assistant message (the full menu) and a user message (capture alone).
- Two states beyond T5's three: `new` (nothing to compare a first run
  against) and `pending` (cancelled before this prompt was reached). Both
  appear in the tally only when non-zero.
- A cancel mid-prompt **drops that row** rather than storing a half-streamed
  answer, which would diff as `changed` for a reason that has nothing to do
  with the model.

**3B [sonnet-5] — R5 layer 1 and wiring.** `format/FormatPane`,
`editor/prompt/PromptView`, `tools/ToolsView`, `ui/Settings`.

- `PaneHelp` wired into three panes with stable ids; layer-1 empty states for
  Format and Tools.
- Settings gains a **Help** section: the tour row ships genuinely `disabled`
  with an honest tooltip rather than a stub that pretends to work, *Reopen
  all* calls `reopenAll()`, and the glossary renders inline from `GLOSSARY`.

**Wiring finished in the main thread.** 3A delivered Bench **complete and
unreachable**: `App.tsx`'s panel router had no `bench` branch, so `openBench`
set the view and fell through to `<ChatView />`; and capture had no home,
because `ChatView` renders a reply menu only for assistant messages. Both
files were outside 3A's scope and it stopped rather than widening it, which
was right. Added here: the `bench` branch, and a separate `promptMenu` for
user messages — its own function rather than a widened `replyMenu`, since
none of that menu's items mean anything on a prompt.

The reachability test renders the **real `App`** rather than a harness, and
was confirmed to fail with the router branch removed.

**Verified live** against Ollama 0.32.15: captured a prompt from a real chat
through the message menu, watched the bench appear in the rail as *1 prompt ·
never run*, and opened it to the run table. A full run against a live model
was not exercised by hand — the run loop is covered by `run.ts`'s tests.
Also confirmed `Message.constrained` survives a reload: a restored chat kept
its conformance card.

**Gates:** `npm run typecheck`, `npm test` (768 passed, 50 files),
`npm run build` — all clean.
