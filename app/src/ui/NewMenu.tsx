/**
 * The rail's primary action (docs/mockup-new-menu.html §01–§03).
 *
 * One button, **never disabled**, opening a two-item menu: New chat and New
 * benchmark. The old "+ New chat" was disabled whenever nothing was resident
 * — a dead control with a tooltip for a door, at the exact moment a new user
 * most needs one. Making the button live and moving the model question
 * behind it is the whole point of the change.
 *
 * The two branches ask very different amounts:
 *
 *  - **New chat** binds a session to one model for its life (SPEC §5.2), so
 *    it needs a model. It asks only when the answer is ambiguous — never
 *    with exactly one resident, since a picker with one row is a question
 *    with one answer.
 *  - **New benchmark** never asks. A lane is a model *and* a Modelfile,
 *    chosen on the benchmark page from every *installed* model
 *    (`BenchmarkPane.laneChoices`, which never reads `isLoaded`), and the
 *    weights are only needed at Run.
 *
 * Chat is first because it is the far more common thing to make. Benchmark
 * being second in a two-item menu with its own description is not hidden —
 * and today the word appears only in a rail header and a disabled `+`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import "./NewMenu.css";
import { ModelPicker } from "./ModelPicker";
import { useRemuda } from "./state";
import { shortTag } from "../chat/sessions";

type Branch = "chat" | "benchmark";

/**
 * What "New chat" will actually do, said before it is clicked.
 *
 * The branch is invisible otherwise: with one model resident it starts a chat
 * outright, and with none or several it opens a picker. Naming the case is
 * what keeps the silent one-resident bind from being a surprise — the model
 * a chat gets bound to should never have to be discovered afterwards.
 */
function chatHint(residentTags: string[]): string {
  if (residentTags.length === 0) return "Pick a model to load";
  if (residentTags.length === 1) return `Talk to ${shortTag(residentTags[0] ?? "")}`;
  return `Choose from ${String(residentTags.length)} models in memory`;
}

export function NewMenu() {
  const { loaded, activeModel, newChat, createAndOpenBenchmark, confirmLeaveEditor } = useRemuda();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  // Esc closes the menu and hands focus back. The picker owns its own Esc:
  // dismissing it cancels the whole action rather than stepping back to here,
  // so the two must not both react to one keypress.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, close]);

  // Opening with the keyboard should land on the first item, the way a menu
  // button is expected to behave. Opening with the mouse does too, which
  // costs a mouse user nothing and saves a keyboard user a Tab.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>("[role='menuitem']");
    first?.focus();
  }, [open]);

  const choose = (branch: Branch) => {
    close(false);
    if (branch === "benchmark") {
      // No question, in any residency state. An unconfigured lane is a valid
      // benchmark; the lane editor is where it gets resolved. One store
      // action, so the SPEC §8 gate runs once and nothing is committed if it
      // refuses.
      createAndOpenBenchmark();
      return;
    }
    // Exactly one resident model is not a choice — bind and go, which is
    // what `newChat()` with no argument already does, gate included.
    if (loaded.length === 1) {
      newChat();
      return;
    }
    // The picker may load weights, so the gate has to be answered before it
    // opens rather than after the load — hence `confirmed` on the newChat
    // below, which would otherwise ask the same question twice.
    if (!confirmLeaveEditor()) return;
    setPicking(true);
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <div className="newmenu" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className="btn primary wide"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        New
      </button>

      {open && (
        <div className="nmenu" role="menu" ref={menuRef} aria-label="New" onKeyDown={onMenuKeyDown}>
          <button type="button" role="menuitem" className="nmi" onClick={() => choose("chat")}>
            <span className="ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-2.8-.4L3 21l1.5-4.6A8.3 8.3 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
              </svg>
            </span>
            <span className="col">
              <b>New chat</b>
              <small>{chatHint(loaded.map((l) => l.variant))}</small>
            </span>
          </button>
          <button type="button" role="menuitem" className="nmi" onClick={() => choose("benchmark")}>
            <span className="ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 20V9M10 20V4M16 20v-7M22 20H2" />
              </svg>
            </span>
            <span className="col">
              <b>New benchmark</b>
              <small>Run one set of prompts across models</small>
            </span>
          </button>
        </div>
      )}

      {picking && (
        <ModelPicker
          preselect={activeModel?.variant ?? null}
          onCancel={() => {
            setPicking(false);
            buttonRef.current?.focus();
          }}
          onChoose={(tag) => {
            setPicking(false);
            newChat(tag, true);
          }}
        />
      )}
    </div>
  );
}
