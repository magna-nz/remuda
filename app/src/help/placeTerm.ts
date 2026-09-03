/**
 * Where a glossary popover goes, given where its word is (R5 layer 3).
 *
 * Pure, for the same reason `tour/place.ts` is: jsdom measures every box as
 * zero, so geometry that lives inside a component cannot be tested at all.
 *
 * The popover is positioned against the **viewport**, not against the word's
 * offset parent. A term sits inside whatever pane happens to contain the
 * sentence, and those panes scroll — `.benchmarkview` is `overflow-y: auto`
 * — so an absolutely positioned popover is clipped by the scroll container
 * the moment the word is near its bottom edge. Viewport coordinates escape
 * that: the popover is laid out against the window and nothing in between
 * can crop it.
 *
 * Below the word first, because that is where a reader's eye already is.
 * Above only when below does not fit, and pinned inside the viewport either
 * way.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Space between the word and its popover. */
const GAP = 7;

/** Closest the popover may sit to a viewport edge. */
const MARGIN = 12;

function clamp(value: number, min: number, max: number): number {
  // max < min when the popover is wider or taller than the viewport itself:
  // pin to the near edge rather than returning a negative that pushes it
  // off-screen entirely.
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * The height a popover may occupy at `top`, so a definition too tall for the
 * space left over scrolls inside itself instead of running off the bottom.
 */
export function availableHeight(viewport: Viewport): number {
  return Math.max(0, viewport.height - MARGIN * 2);
}

export function placeTerm(
  word: Rect,
  viewport: Viewport,
  popWidth: number,
  popHeight: number,
): { left: number; top: number } {
  const below = word.top + word.height + GAP;
  const above = word.top - GAP - popHeight;

  // Below unless it would overrun the bottom margin and there is genuinely
  // more room above. A popover taller than both gaps is clamped, not
  // flipped: flipping would only trade one overrun for another.
  const fitsBelow = below + popHeight + MARGIN <= viewport.height;
  const roomAbove = word.top;
  const roomBelow = viewport.height - (word.top + word.height);
  const top = fitsBelow || roomBelow >= roomAbove ? below : above;

  return {
    left: clamp(word.left, MARGIN, viewport.width - popWidth - MARGIN),
    top: clamp(top, MARGIN, viewport.height - popHeight - MARGIN),
  };
}
