/**
 * Where the step card goes, given where the spotlight is. Pure, so the
 * geometry is testable without a layout engine — jsdom measures everything
 * as zero, which would make this untestable in a render test.
 *
 * Beside the target first (right, then left), because a card sitting *over*
 * the thing it is describing is the same mistake `PaneHelp` exists to avoid.
 * Only when neither side fits does it fall back to below/above.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** The card's fixed width, shared with Tour.css. */
export const CARD_WIDTH = 322;

/** Breathing room between the spotlight and the card, and against the viewport edge. */
const GAP = 14;
const MARGIN = 12;

function clamp(value: number, min: number, max: number): number {
  // max < min when the card is taller than the viewport: pin to the top edge
  // rather than returning a negative that scrolls it off.
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function placeCard(target: Box, viewport: Viewport, cardHeight: number): { left: number; top: number } {
  const rightOf = target.left + target.width + GAP;
  const leftOf = target.left - GAP - CARD_WIDTH;

  let left: number;
  let top: number;
  if (rightOf + CARD_WIDTH + MARGIN <= viewport.width) {
    left = rightOf;
    top = target.top;
  } else if (leftOf >= MARGIN) {
    left = leftOf;
    top = target.top;
  } else {
    // Neither flank fits: sit under the target, or over it if there is more
    // room above than below.
    left = target.left;
    const below = target.top + target.height + GAP;
    top = below + cardHeight + MARGIN <= viewport.height ? below : target.top - GAP - cardHeight;
  }

  return {
    left: clamp(left, MARGIN, viewport.width - CARD_WIDTH - MARGIN),
    top: clamp(top, MARGIN, viewport.height - cardHeight - MARGIN),
  };
}
