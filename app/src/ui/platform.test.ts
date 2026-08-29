import { describe, expect, it } from "vitest";

import { pasteChord } from "./platform";

describe("pasteChord", () => {
  it("names the Command key on Apple platforms", () => {
    for (const platform of ["MacIntel", "macOS", "Mac OS X", "iPhone", "iPad"]) {
      expect(pasteChord(platform)).toBe("⌘V");
    }
  });

  // The bug this exists for: ⌘V named a key a Linux keyboard does not have.
  it("names Ctrl on Linux and Windows", () => {
    for (const platform of [
      "Linux x86_64",
      "Linux",
      "Windows",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15",
    ]) {
      expect(pasteChord(platform)).toBe("Ctrl+V");
    }
  });

  // Apple is the only platform that pastes with something other than Ctrl, so
  // an unrecognised host is far likelier to want Ctrl than ⌘.
  it("falls back to Ctrl when the platform is unknown", () => {
    expect(pasteChord("")).toBe("Ctrl+V");
    expect(pasteChord("something-unheard-of")).toBe("Ctrl+V");
  });
});
