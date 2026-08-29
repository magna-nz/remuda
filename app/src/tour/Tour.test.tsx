import "../chat/test/localStorage";
/**
 * The guided tour, on the real UI (docs/SPEC-round-two.md R6).
 *
 * Every test here renders the actual `App` — a harness would prove the card
 * renders and nothing about the thing the spec is actually worried about,
 * which is whether the tour survives the app it is pointed at. The two
 * states that matter are the empty one (no Ollama, no models, no chats, no
 * benches: the likeliest first launch there is) and the full one.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { FakeClient, makeModel } from "../ui/test/FakeClient";
import { isTourRunning, startTour, stopTour } from "./controller";
import { TOUR_STEPS } from "./steps";
import { SESSIONS_STORAGE_KEY } from "../chat/sessions";

const MODEL = "terse-v2:latest";

/** A server that isn't there — no version, no models, nothing to load. */
function offlineClient(): FakeClient {
  return new FakeClient({ connected: false, models: [] });
}

function loadedClient(): FakeClient {
  return new FakeClient({
    models: [makeModel({ tag: MODEL, isLoaded: true })],
    modelfile: 'FROM llama3\nSYSTEM "be terse"\nTEMPLATE """{{ .System }}\n{{ .Prompt }}"""\n',
  });
}

/** The "Step N of M" line, or null when no card is up. */
function stepLine(): string | null {
  return document.querySelector(".tour-card .tc-step")?.textContent ?? null;
}

function cardTitle(): string | null {
  return document.querySelector(".tour-card h4")?.textContent ?? null;
}

function dots(): string[] {
  return Array.from(document.querySelectorAll(".tour-dots i")).map((el) => el.className);
}

function clickNext() {
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
}

/** Seed one saved chat, so the composer (and its Format pill) has a home. */
function seedSession() {
  window.localStorage.setItem(
    SESSIONS_STORAGE_KEY,
    JSON.stringify([
      {
        id: "s-1",
        title: "Tuning the coding system prompt",
        model: MODEL,
        updatedAt: new Date().toISOString(),
        messages: [{ id: "m-1", role: "user", content: "Explain a mutex in one line." }],
      },
    ]),
  );
}

async function untilLoaded() {
  await waitFor(() => expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled());
}

/** Open the Modelfile editor, so the Prompt segment exists to be pointed at. */
async function openEditor() {
  fireEvent.click(screen.getByRole("button", { name: "Modelfile" }));
  await screen.findByRole("group", { name: "Editor view" });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  // Module-level state: a test that leaves the tour running poisons the next.
  act(() => stopTour());
});

describe("the first-run offer", () => {
  it("is a card in the flow, not a modal — the app underneath stays usable", async () => {
    render(<App client={offlineClient()} />);
    await screen.findByText("First time here? Remuda in five steps.");

    // Not a dialog, nothing trapped, and the rail behind it still works.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Get Models" }));
    expect(await screen.findByRole("button", { name: "Get Models" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("is offered once: 'Not now' settles it, including across a remount", async () => {
    const { unmount } = render(<App client={offlineClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByText("First time here? Remuda in five steps.")).not.toBeInTheDocument();
    unmount();

    render(<App client={offlineClient()} />);
    await screen.findByRole("button", { name: "Get Models" });
    expect(screen.queryByText("First time here? Remuda in five steps.")).not.toBeInTheDocument();
  });

  it("'Take the tour' starts it, and does not offer again afterwards", async () => {
    const { unmount } = render(<App client={offlineClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Take the tour" }));

    expect(stepLine()).toBe("Step 1 of 5");
    act(() => stopTour());
    expect(screen.queryByText("First time here? Remuda in five steps.")).not.toBeInTheDocument();
    unmount();

    render(<App client={offlineClient()} />);
    await screen.findByRole("button", { name: "Get Models" });
    expect(screen.queryByText("First time here? Remuda in five steps.")).not.toBeInTheDocument();
  });
});

describe("a first launch with no Ollama", () => {
  it("runs end to end with no models, no chats, no benches and a dead server", async () => {
    render(<App client={offlineClient()} />);
    // The state under test, asserted rather than assumed.
    await screen.findByText("Not running");
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
    expect(screen.getByText(/A bench is a set of prompts you re-run/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));

    // 1 — the model control, which is exactly what this user needs to find.
    expect(cardTitle()).toBe(TOUR_STEPS[0]!.title);
    expect(stepLine()).toBe("Step 1 of 5");
    clickNext();
    // 2 — the Modelfile editor, reached through the tab strip, which is
    // chrome and therefore present with nothing loaded.
    expect(cardTitle()).toBe(TOUR_STEPS[1]!.title);
    clickNext();
    // 3 — the Benches rail group, which names itself when empty.
    expect(cardTitle()).toBe(TOUR_STEPS[2]!.title);

    // 4 and 5 have no targets on an empty app: no composer, no draft. The
    // tour steps over both rather than wedging on either — and then *says
    // so*. Vanishing after three of a promised five reads as broken.
    clickNext();
    expect(isTourRunning()).toBe(true);
    expect(screen.getByText("That’s the tour")).toBeInTheDocument();
    expect(screen.getByText("Saw 3 of 5")).toBeInTheDocument();
    // Named, with the reason, rather than left as a silent gap.
    expect(screen.getByText(/needs a chat open/)).toBeInTheDocument();
    expect(screen.getByText(/needs a model loaded/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(isTourRunning()).toBe(false);

    // And the app is still the app.
    expect(screen.getByRole("button", { name: "Get Models" })).toBeEnabled();
  });
});

describe("a step whose target is missing", () => {
  it("is skipped, and the count stops claiming it", async () => {
    // A loaded model and an open draft, but no chat: Format's pill has
    // nowhere to live, while the Prompt segment does.
    render(<App client={loadedClient()} />);
    await untilLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await openEditor();

    act(() => startTour());
    expect(stepLine()).toBe("Step 1 of 5");
    clickNext();
    clickNext();
    expect(cardTitle()).toBe(TOUR_STEPS[2]!.title);

    // Next lands on Format, finds no pill, and carries straight through to
    // Prompt — whose target is there, because the editor is open.
    clickNext();
    expect(cardTitle()).toBe(TOUR_STEPS[4]!.title);
    expect(stepLine()).toBe("Step 4 of 4");
    expect(dots()).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();

    // Done on the last *reachable* step still owes the user an account of
    // the one it stepped over, so the closing card names Format and why.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("Saw 4 of 5")).toBeInTheDocument();
    expect(screen.getByText(/needs a chat open/)).toBeInTheDocument();
    // And nothing is claimed about Prompt, which the user actually saw.
    expect(screen.queryByText(/needs a model loaded/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(isTourRunning()).toBe(false);
  });

  it("reaches all five when every target is on screen", async () => {
    seedSession();
    render(<App client={loadedClient()} />);
    await untilLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    fireEvent.click(screen.getByText("Tuning the coding system prompt"));
    await screen.findByRole("button", { name: /^Format/ });
    await openEditor();

    act(() => startTour());
    for (let i = 0; i < 4; i += 1) {
      expect(cardTitle()).toBe(TOUR_STEPS[i]!.title);
      expect(stepLine()).toBe(`Step ${i + 1} of 5`);
      clickNext();
    }
    expect(cardTitle()).toBe(TOUR_STEPS[4]!.title);
    expect(dots()).toEqual(["", "", "", "", "on"]);
    // The last step actually opened the pane it is describing.
    expect(screen.getByRole("button", { name: "Prompt" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("leaving", () => {
  it("Skip ends it", async () => {
    render(<App client={offlineClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Take the tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(stepLine()).toBeNull();
    expect(isTourRunning()).toBe(false);
  });

  it("Esc ends it", async () => {
    render(<App client={offlineClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Take the tour" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(stepLine()).toBeNull();
    expect(isTourRunning()).toBe(false);
  });

  it("puts the app back where it found it", async () => {
    render(<App client={offlineClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run the tour" }));

    // Step one switched away from Settings to show the model control…
    expect(stepLine()).toBe("Step 1 of 5");
    expect(screen.queryByRole("region", { name: "Settings" })).not.toBeInTheDocument();

    // …and leaving hands Settings back, where the row that started it is.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("region", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("the keyboard", () => {
  async function startOnEmptyApp() {
    render(<App client={offlineClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Take the tour" }));
  }

  it("→ and ← move between steps", async () => {
    await startOnEmptyApp();
    expect(cardTitle()).toBe(TOUR_STEPS[0]!.title);

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(cardTitle()).toBe(TOUR_STEPS[1]!.title);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(cardTitle()).toBe(TOUR_STEPS[2]!.title);
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(cardTitle()).toBe(TOUR_STEPS[1]!.title);
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(cardTitle()).toBe(TOUR_STEPS[0]!.title);

    // Nothing before step one: ← is a no-op, not an exit.
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(cardTitle()).toBe(TOUR_STEPS[0]!.title);
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  });

  it("keeps focus inside the card", async () => {
    await startOnEmptyApp();
    const card = screen.getByRole("dialog");
    expect(document.activeElement).toBe(card);

    const skip = screen.getByRole("button", { name: "Skip" });
    const next = screen.getByRole("button", { name: "Next" });

    // Tab off the end wraps to the start rather than reaching the app behind.
    next.focus();
    fireEvent.keyDown(next, { key: "Tab" });
    expect(document.activeElement).toBe(skip);

    // And Shift+Tab off the front wraps to the end.
    fireEvent.keyDown(skip, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(next);
  });
});
