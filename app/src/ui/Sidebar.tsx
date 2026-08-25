/**
 * Chats rail (SPEC.md §5, §5.2). M1 is read-only: the list itself (saved
 * sessions, search, "+ New chat") lands in M2 — this is the placeholder
 * skeleton the mockup shows, with the footer's settings gear wired up.
 */
import "./Sidebar.css";
import { useRemuda } from "./state";

export function Sidebar() {
  const { view, setView } = useRemuda();

  return (
    <aside className="sidebar" aria-label="Chats">
      <div className="side-search">
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input type="search" placeholder="Search chats…" aria-label="Search chats" />
        </div>
      </div>
      <div className="side-new">
        <button type="button" className="btn primary wide" disabled title="coming in M2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
        </button>
      </div>
      <div className="side-label">Recent</div>
      <div className="sesslist">
        <p className="empty-note">No chats yet — chat history arrives in M2.</p>
      </div>
      <div className="side-foot">
        <button type="button" className="btn wide" disabled title="coming in M4">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
          </svg>
          Pull models
        </button>
        <button
          type="button"
          className="btn iconbtn"
          title="Settings"
          aria-pressed={view === "settings"}
          onClick={() => setView(view === "settings" ? "chat" : "settings")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
