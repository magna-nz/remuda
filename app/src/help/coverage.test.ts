/**
 * Every pane carries a `?`.
 *
 * Wave 3 wired the explainer into Format, Prompt and Tools and deliberately
 * skipped Bench, on the reasoning that Bench ships its own empty state. That
 * was wrong in the way that matters: the empty state disappears the moment a
 * bench has a prompt in it, so the one word a new user is least likely to
 * know lost its explanation permanently, with no way to get it back.
 *
 * A source-level check rather than a render test, because the point is
 * coverage *across* panes — a render test per pane is exactly what let the
 * gap open in the first place. Sources are read through Vite's raw glob, so
 * this needs no Node types the app does not otherwise carry.
 */
import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("../**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function source(file: string): string {
  const key = Object.keys(SOURCES).find((k) => k.endsWith(`/${file}`));
  if (key === undefined) throw new Error(`no source for ${file}`);
  return SOURCES[key]!;
}

const PANES: Array<[string, string]> = [
  ["BenchmarkView.tsx", "benchmark"],
  ["ChatView.tsx", "chat"],
  ["EditorView.tsx", "modelfile"],
  ["PullView.tsx", "pull"],
  ["FormatPane.tsx", "format"],
  ["PromptView.tsx", "prompt"],
  ["ToolsView.tsx", "tools"],
];

describe("pane help coverage", () => {
  it.each(PANES)("%s has a ? and a strip", (file, paneId) => {
    const src = source(file);
    expect(src).toContain(`<PaneHelpToggle paneId="${paneId}"`);
    expect(src).toMatch(/<PaneHelp\b/);
  });

  it("gives each toggle a distinct accessible name", () => {
    const names = PANES.map(([file]) => /<PaneHelpToggle[^>]*label="([^"]+)"/.exec(source(file))?.[1] ?? null);
    expect(names.every((n) => n !== null)).toBe(true);
    // Two "About this pane" buttons on one screen is ambiguous to a screen
    // reader — the Modelfile page shows the editor's and Prompt's together.
    expect(new Set(names).size).toBe(names.length);
  });
});
