/**
 * Placement for the glossary popover (R5 layer 3).
 *
 * The case that produced this module: a term near the bottom of a scrolling
 * pane had its last line cropped, because the popover was positioned inside
 * a container with `overflow-y: auto`. These assert the geometry that keeps
 * the whole definition on screen.
 */
import { describe, expect, it } from "vitest";
import { availableHeight, placeTerm } from "./placeTerm";

const VIEW = { width: 1200, height: 800 };
const WORD = { left: 300, top: 200, width: 40, height: 16 };

describe("placeTerm", () => {
  it("sits just below the word when there is room", () => {
    expect(placeTerm(WORD, VIEW, 290, 150)).toEqual({ left: 300, top: 223 });
  });

  it("flips above when the popover would overrun the bottom", () => {
    // The word is 40px from the bottom; 150px of popover cannot follow it.
    const low = { ...WORD, top: 760 };
    const { top } = placeTerm(low, VIEW, 290, 150);
    expect(top).toBe(760 - 7 - 150);
    expect(top + 150).toBeLessThanOrEqual(VIEW.height);
  });

  it("keeps a wide popover inside the right edge", () => {
    const far = { ...WORD, left: 1150 };
    expect(placeTerm(far, VIEW, 290, 100).left).toBe(1200 - 290 - 12);
  });

  it("pins to the near edge rather than going negative", () => {
    // Taller than the viewport: there is no placement that fits, so the
    // top margin wins and the popover scrolls inside itself.
    expect(placeTerm(WORD, VIEW, 290, 5000).top).toBe(12);
    expect(placeTerm(WORD, { width: 100, height: 800 }, 290, 100).left).toBe(12);
  });

  it("never proposes a height that exceeds the viewport", () => {
    expect(availableHeight(VIEW)).toBe(800 - 24);
    expect(availableHeight({ width: 100, height: 10 })).toBe(0);
  });
});
