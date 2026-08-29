/**
 * Card placement (R6). Pure geometry, tested without a layout engine —
 * jsdom measures every element as a zero-size box, so this is the only
 * place the positioning can actually be checked.
 */
import { describe, expect, it } from "vitest";
import { CARD_WIDTH, placeCard } from "./place";

const VIEWPORT = { width: 1280, height: 800 };

describe("placeCard", () => {
  it("sits to the right of the target when there is room", () => {
    const { left, top } = placeCard({ left: 20, top: 60, width: 200, height: 40 }, VIEWPORT, 200);
    expect(left).toBe(20 + 200 + 14);
    expect(top).toBe(60);
  });

  it("flips to the left when the right flank would overflow", () => {
    const { left } = placeCard({ left: 1100, top: 60, width: 120, height: 40 }, VIEWPORT, 200);
    expect(left).toBe(1100 - 14 - CARD_WIDTH);
  });

  it("drops below the target when neither flank fits", () => {
    const wide = { left: 10, top: 100, width: 1260, height: 40 };
    const { left, top } = placeCard(wide, VIEWPORT, 200);
    // Nudged to the 12px margin: the target starts inside it.
    expect(left).toBe(12);
    expect(top).toBe(100 + 40 + 14);
  });

  it("goes above instead when there is no room below", () => {
    const wide = { left: 10, top: 700, width: 1260, height: 40 };
    const { top } = placeCard(wide, VIEWPORT, 200);
    expect(top).toBe(700 - 14 - 200);
  });

  it("never leaves the viewport, even for a target in the bottom corner", () => {
    const { left, top } = placeCard({ left: 1270, top: 790, width: 10, height: 10 }, VIEWPORT, 200);
    expect(left).toBeGreaterThanOrEqual(12);
    expect(left + CARD_WIDTH).toBeLessThanOrEqual(VIEWPORT.width - 12);
    expect(top).toBeGreaterThanOrEqual(12);
    expect(top + 200).toBeLessThanOrEqual(VIEWPORT.height - 12);
  });

  it("pins to the top edge rather than going negative when the card is taller than the window", () => {
    const { top } = placeCard({ left: 20, top: 40, width: 100, height: 30 }, { width: 1280, height: 300 }, 400);
    expect(top).toBe(12);
  });

  it("survives the zero-size box jsdom hands every element", () => {
    const { left, top } = placeCard({ left: 0, top: 0, width: 0, height: 0 }, VIEWPORT, 200);
    expect(Number.isFinite(left)).toBe(true);
    expect(Number.isFinite(top)).toBe(true);
    expect(top).toBe(12);
  });
});
