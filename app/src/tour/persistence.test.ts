import "../chat/test/localStorage";
/**
 * The first-run offer's one boolean (R6). Same shape as
 * help/persistence.test.ts: the corrupt-payload cases matter more than the
 * happy path, because this key is read on every boot and a throw here is a
 * blank window.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOUR_STORAGE_KEY,
  dismissFirstRunOffer,
  isFirstRunOfferDismissed,
  subscribeTourOffer,
} from "./persistence";

beforeEach(() => {
  window.localStorage.clear();
});

describe("the first-run offer's persistence", () => {
  it("is undismissed on a genuinely first launch", () => {
    expect(isFirstRunOfferDismissed()).toBe(false);
  });

  it("remembers a dismissal", () => {
    dismissFirstRunOffer();
    expect(isFirstRunOfferDismissed()).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(TOUR_STORAGE_KEY) ?? "{}")).toEqual({
      offerDismissed: true,
    });
  });

  it("notifies subscribers once, and not again for a repeat dismissal", () => {
    const seen = vi.fn();
    const unsubscribe = subscribeTourOffer(seen);
    dismissFirstRunOffer();
    dismissFirstRunOffer();
    expect(seen).toHaveBeenCalledTimes(1);
    unsubscribe();
    dismissFirstRunOffer();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not JSON at all", "{{{"],
    ["a bare string", '"yes"'],
    ["null", "null"],
    ["an array", "[true]"],
    ["a number", "7"],
    ["the wrong field type", '{"offerDismissed":"true"}'],
    ["an empty object", "{}"],
  ])("reads %s as 'not answered yet' rather than throwing", (_label, raw) => {
    window.localStorage.setItem(TOUR_STORAGE_KEY, raw);
    expect(() => isFirstRunOfferDismissed()).not.toThrow();
    expect(isFirstRunOfferDismissed()).toBe(false);
  });
});
