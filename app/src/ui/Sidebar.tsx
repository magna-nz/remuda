/**
 * Chats rail (SPEC.md §5, §5.2; docs/mockup.html session rows).
 *
 * The saved-session list: each row shows the title, the model tag it ran on
 * with a status dot (green = loaded now, hollow amber + "unloaded" = not),
 * and a relative time. "+ New chat" binds a session to the currently loaded
 * model, so it needs one loaded. Search filters by title substring.
 */
import { useState } from "react";
import "./Sidebar.css";
import { relativeTime, shortTag, type ChatSession } from "../chat/sessions";
import { useRemuda } from "./state";

function SessionRow({ session, active }: { session: ChatSession; active: boolean }) {
  const { models, openSession, deleteSession } = useRemuda();
  const isLoaded = models.some((m) => m.tag === session.model && m.isLoaded);

  return (
    <div className={active ? "sess active" : "sess"}>
      <button
        type="button"
        className="sess-open"
        onClick={() => openSession(session.id)}
        aria-current={active || undefined}
      >
        <div className="stitle">{session.title}</div>
        <div className="smodel">
          <span className={isLoaded ? "sdot" : "sdot off"} aria-hidden="true" />
          {shortTag(session.model)}
          {!isLoaded && <span className="stag">· unloaded</span>}
          <span className="stime">{relativeTime(session.updatedAt)}</span>
        </div>
      </button>
      <button
        type="button"
        className="sess-x"
        title={`Delete ${session.title}`}
        aria-label={`Delete ${session.title}`}
        onClick={(e) => {
          e.stopPropagation();
          deleteSession(session.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

export function Sidebar() {
  const { view, setView, sessions, activeSessionId, loaded, newChat } = useRemuda();
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = q === "" ? sessions : sessions.filter((s) => s.title.toLowerCase().includes(q));

  return (
    <aside className="sidebar" aria-label="Chats">
      <div className="side-search">
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            type="search"
            placeholder="Search chats…"
            aria-label="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="side-new">
        <button
          type="button"
          className="btn primary wide"
          disabled={!loaded}
          title={loaded ? undefined : "Load a model first"}
          onClick={newChat}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
        </button>
      </div>
      <div className="side-label">Recent</div>
      <div className="sesslist">
        {filtered.length === 0 ? (
          <p className="empty-note">
            {sessions.length === 0
              ? "No chats yet — load a model, then start one."
              : "No chats match."}
          </p>
        ) : (
          filtered.map((s) => (
            <SessionRow key={s.id} session={s} active={s.id === activeSessionId} />
          ))
        )}
      </div>
      <div className="side-foot">
        <button
          type="button"
          className="btn wide"
          aria-pressed={view === "pull"}
          onClick={() => setView(view === "pull" ? "chat" : "pull")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
          </svg>
          Get Models
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
