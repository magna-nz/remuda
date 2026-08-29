/**
 * The tour, as data (docs/SPEC-round-two.md R6; mockup-proposals-2.html §06).
 *
 * Five steps, declared once: the model control, the Modelfile editor, Bench,
 * Format, the rendered prompt. Nothing here renders — `Tour.tsx` reads this
 * list, and the components being pointed at register themselves against
 * these ids through `registry.ts`.
 *
 * **No step may require a loaded model.** A first launch with Ollama not
 * installed is the likeliest first launch there is, and it is exactly the
 * one a tour that demands a resident model falls over on. Two of the five
 * targets (Format's pill, the editor's Prompt segment) only exist once
 * there is a chat or a draft to hang them off — those steps are *skipped*
 * on an empty app rather than wedging it, which is why `Tour.tsx` counts
 * the steps it can actually show rather than always saying "of 5".
 */
import type { EditorPane, View } from "../ui/state";

export type TourStepId = "model-control" | "modelfile" | "bench" | "format" | "prompt";

export interface TourStep {
  /** Stable: it is both the registry key and the dot's React key. */
  id: TourStepId;
  /**
   * Why this step's target might not be on screen, in the user's terms.
   *
   * Shown in the closing card when the step was skipped. A tour that
   * promised five steps and silently delivered three reads as broken; naming
   * what was missing, and what to do to see it, turns a truncation into
   * information.
   */
  missingNote?: string;
  title: string;
  body: string;
  /**
   * The surface this step's target lives on, switched to before the step is
   * shown. Omitted when the target is chrome that every view carries (the
   * top nav, the rail), which is what makes those steps safe on an app with
   * nothing loaded.
   */
  view?: View;
  /** The editor segment to open, for the one step that lives inside it. */
  editorPane?: EditorPane;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "model-control",
    title: "Start here — pick a model and load it",
    body:
      "Everything else in Remuda runs against a model held in memory. This control chooses one and loads it, and the chips beside it then say where the weights sit and how much of the context window is gone. If Ollama isn’t running yet, this is where it tells you.",
    view: "chat",
  },
  {
    id: "modelfile",
    title: "The Modelfile — the loop this app exists for",
    body:
      "A Modelfile is the model’s own configuration: its system prompt, its sampling parameters, its template. Open it beside the chat, change one thing, save it as a new variant, and ask the same question again.",
    view: "chat",
  },
  {
    id: "bench",
    title: "Benches — your re-run list",
    body:
      "When you change a Modelfile you change everything the model does, not just the bit you were fixing. A bench is a handful of prompts you keep, replay after each save, and check for answers that moved. Add one from any chat message.",
    view: "chat",
  },
  {
    id: "format",
    title: "Format — make the reply a shape",
    body:
      "Give Remuda a JSON schema and the model is only ever allowed to produce text that fits it. Useful when you want data back rather than prose, and it saves you writing “reply in JSON like this…” into your system prompt, where it drifts.",
    view: "chat",
    missingNote: "Format lives in the composer, so it needs a chat open.",
  },
  {
    id: "prompt",
    title: "Prompt — see what the model is actually sent",
    body:
      "Your system prompt doesn’t reach the model as you typed it; Ollama wraps it in the model’s own template first. If a system prompt ever seems to be ignored, look here — you’ll see whether it arrived at all.",
    view: "modelfile",
    missingNote: "Prompt is part of the Modelfile editor, so it needs a model loaded.",
    editorPane: "prompt",
  },
];
