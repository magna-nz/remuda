import "../chat/test/localStorage";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HELP_STORAGE_KEY,
  dismissedPanes,
  isPaneHelpOpen,
  reopenAll,
  setPaneHelpOpen,
  subscribeHelp,
} from "./persistence";

describe("help persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("treats a pane it has never seen as open", () => {
    expect(isPaneHelpOpen("bench")).toBe(true);
    expect(dismissedPanes().size).toBe(0);
  });

  it("persists a dismissal under remuda.help.v1", () => {
    setPaneHelpOpen("bench", false);
    expect(isPaneHelpOpen("bench")).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(HELP_STORAGE_KEY) as string)).toEqual({
      dismissed: ["bench"],
    });
  });

  it("keeps panes independent", () => {
    setPaneHelpOpen("bench", false);
    expect(isPaneHelpOpen("format")).toBe(true);
  });

  it("reopenAll clears every dismissal", () => {
    setPaneHelpOpen("bench", false);
    setPaneHelpOpen("format", false);
    setPaneHelpOpen("prompt", false);

    reopenAll();

    expect(dismissedPanes().size).toBe(0);
    for (const pane of ["bench", "format", "prompt"]) expect(isPaneHelpOpen(pane)).toBe(true);
  });

  it("notifies subscribers on change and on reopenAll, and stops after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeHelp(() => {
      calls += 1;
    });

    setPaneHelpOpen("bench", false);
    expect(calls).toBe(1);
    // A no-op write must not notify.
    setPaneHelpOpen("bench", false);
    expect(calls).toBe(1);
    reopenAll();
    expect(calls).toBe(2);

    unsubscribe();
    setPaneHelpOpen("bench", false);
    expect(calls).toBe(2);
  });

  describe("corrupt storage", () => {
    const corrupt = ["{not json", "null", '"a string"', "[]", '{"dismissed":"bench"}', '{"dismissed":[1,2]}'];

    it.each(corrupt)("reads %s as nothing dismissed, without throwing", (raw) => {
      window.localStorage.setItem(HELP_STORAGE_KEY, raw);
      expect(() => isPaneHelpOpen("bench")).not.toThrow();
      expect(isPaneHelpOpen("bench")).toBe(true);
      expect(dismissedPanes().size).toBe(0);
    });

    it("repairs itself on the next write", () => {
      window.localStorage.setItem(HELP_STORAGE_KEY, "{not json");
      setPaneHelpOpen("bench", false);
      expect(JSON.parse(window.localStorage.getItem(HELP_STORAGE_KEY) as string)).toEqual({
        dismissed: ["bench"],
      });
    });

    it("keeps the string entries of a partly-corrupt list and drops the rest", () => {
      window.localStorage.setItem(HELP_STORAGE_KEY, '{"dismissed":["format",7,null]}');
      expect(Array.from(dismissedPanes())).toEqual(["format"]);
      expect(isPaneHelpOpen("format")).toBe(false);
    });
  });
});
