/**
 * Driving the rail's "+ New" menu from tests.
 *
 * The old "+ New chat" button was disabled until a model was resident, which
 * made `toBeEnabled()` a convenient stand-in for "the health check has come
 * back". The button is never disabled now — that dead control was the whole
 * point of the change — so the readiness signal moved to the menu item's own
 * description, which names what "New chat" will do with the models it can
 * see ("Talk to llama3.1:8b", "Choose from 3 models in memory").
 */
import { fireEvent, screen } from "@testing-library/react";

/** The menu item description, once /api/ps has reported a resident model. */
const RESIDENT_HINT = /Talk to |Choose from /;

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "New" }));
}

/**
 * Wait for the first health check to report a resident model, without
 * starting anything. Opens the menu to read its hint and closes it again.
 */
export async function untilModelResident(): Promise<void> {
  openMenu();
  await screen.findByText(RESIDENT_HINT);
  // Toggle shut, so the menu is not left over the surface under test.
  openMenu();
}

/**
 * "+ New ▸ New chat", after waiting for a resident model.
 *
 * With exactly one model resident this starts the chat outright; the picker
 * only opens with none or several, which is what the callers here rely on.
 */
export async function startNewChat(): Promise<void> {
  openMenu();
  await screen.findByText(RESIDENT_HINT);
  fireEvent.click(screen.getByRole("menuitem", { name: /New chat/ }));
}
