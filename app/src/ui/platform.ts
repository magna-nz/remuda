/**
 * Platform-dependent wording for UI hints.
 *
 * Nothing about the *behaviour* here is platform-specific: ChatView's paste
 * handler is a `paste` event, which fires whatever the user pressed. Only the
 * label is, and on a Linux keyboard "⌘V" names a key that does not exist.
 *
 * Read from the webview rather than through the Rust bridge on purpose. These
 * are render-time strings; `hostStats()` is async and resolves to null outside
 * the desktop shell, so sourcing them there would give a hint that arrives
 * late in the app and never at all in a browser tab.
 */

/** The platform string, from the best source this webview offers. */
function platformString(): string {
  if (typeof navigator === "undefined") return "";
  const withData = navigator as Navigator & { userAgentData?: { platform?: string } };
  return withData.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
}

/**
 * How to name the paste chord.
 *
 * Apple platforms are matched explicitly and everything else falls through to
 * `Ctrl` — including an unrecognised platform string. That direction is
 * deliberate: Apple is the only platform that pastes with anything other than
 * Ctrl, so an unknown host is far more likely to want Ctrl than ⌘.
 *
 * `platform` is injectable so this is testable without stubbing `navigator`.
 */
export function pasteChord(platform: string = platformString()): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘V" : "Ctrl+V";
}
