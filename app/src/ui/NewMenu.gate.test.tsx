/**
 * The SPEC §8 unsaved-Modelfile gate, and *when* it runs relative to work
 * that cannot be taken back.
 *
 * Both branches of "+ New" navigate away from the editor, so both have to
 * ask. What matters is the order: asking after the fact leaves either a
 * committed benchmark nobody wanted or a multi-GB load nobody got a chat
 * for. And asking twice for one action is its own bug.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../chat/test/localStorage";
import App from "../App";
import { FakeClient, makeModel } from "./test/FakeClient";
import { BENCHMARK_STORAGE_KEY } from "../benchmark/types";
import { SESSIONS_STORAGE_KEY } from "../chat/sessions";

function stored(key: string): unknown[] {
  return JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown[];
}

/** Open the Modelfile editor and leave an unsaved edit in it. */
async function dirtyEditor() {
  fireEvent.click(screen.getByRole("button", { name: "Modelfile" }));
  // openEditor awaits /api/show before a draft exists.
  await act(async () => {});
  const raw = (await screen.findByLabelText("Raw Modelfile")) as HTMLTextAreaElement;
  fireEvent.change(raw, { target: { value: `${raw.value}\n# unsaved edit` } });
}

function openNewMenu() {
  fireEvent.click(screen.getByRole("button", { name: "New" }));
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("remuda.tour.seen.v1", "true");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("+ New, with unsaved Modelfile changes", () => {
  it("creates no benchmark when the discard prompt is refused", async () => {
    const client = new FakeClient({ models: [makeModel({ tag: "a:7b", isLoaded: true })] });
    render(<App client={client} />);
    await screen.findByRole("button", { name: "New" });
    await dirtyEditor();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    openNewMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /New benchmark/ }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // The old order committed first and navigated second, so refusing left a
    // stray "Untitled benchmark" in the rail and the user still in the editor.
    expect(stored(BENCHMARK_STORAGE_KEY)).toHaveLength(0);
    expect(screen.getByLabelText("Raw Modelfile")).toBeInTheDocument();
  });

  it("asks once, not twice, when the discard prompt is accepted", async () => {
    const client = new FakeClient({ models: [makeModel({ tag: "a:7b", isLoaded: true })] });
    render(<App client={client} />);
    await screen.findByRole("button", { name: "New" });
    await dirtyEditor();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    openNewMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /New benchmark/ }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(stored(BENCHMARK_STORAGE_KEY)).toHaveLength(1));
  });

  it("loads nothing when the prompt is refused on the way to the picker", async () => {
    // Two resident models, so New chat would open the picker.
    const client = new FakeClient({
      models: [
        makeModel({ tag: "a:7b", isLoaded: true }),
        makeModel({ tag: "b:7b", isLoaded: true }),
      ],
    });
    render(<App client={client} />);
    await screen.findByRole("button", { name: "New" });
    await dirtyEditor();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    openNewMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /New chat/ }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // The gate has to be answered before the picker can spend a load, not
    // after — a refusal afterwards would have thrown the weights away.
    expect(screen.queryByRole("dialog", { name: /model/i })).not.toBeInTheDocument();
    expect(client.loadCalls).toHaveLength(0);
    expect(stored(SESSIONS_STORAGE_KEY)).toHaveLength(0);
  });

  it("asks once for the whole picker flow, including the load", async () => {
    const client = new FakeClient({
      models: [
        makeModel({ tag: "a:7b", isLoaded: true }),
        makeModel({ tag: "b:7b", isLoaded: true }),
        makeModel({ tag: "cold:13b" }),
      ],
    });
    render(<App client={client} />);
    await screen.findByRole("button", { name: "New" });
    await dirtyEditor();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    openNewMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /New chat/ }));

    const dialog = await screen.findByRole("dialog");
    // Already asked, before a single byte was loaded. Without the pre-gate
    // this is 0 here and the question only comes after the load.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: /Load a different model/ }));
    fireEvent.click(within(dialog).getByRole("radio", { name: /cold:13b/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Load and start chat" }));

    await waitFor(() => expect(stored(SESSIONS_STORAGE_KEY)).toHaveLength(1));
    // One navigation, one question — `newChat(tag, confirmed)` is what keeps
    // the post-load gate from asking the same thing again.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });
});
