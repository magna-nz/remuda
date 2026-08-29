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
