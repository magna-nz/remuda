/**
 * Chats rail (SPEC.md §5, §5.2; docs/mockup.html session rows).
 *
 * The saved-session list. A row is one line — status dot (green = the model
 * is loaded now, hollow amber = not), title, relative time — so the rail
 * shows as much history as it can. The model tag itself only spells itself
 * out on the open chat; elsewhere it lives in the row's tooltip, and in
 * screen-reader text so the dot is never the only carrier of the state.
 * "+ New" (NewMenu) is the rail's primary action and is never disabled: the
 * model question lives behind it, and only the chat branch ever asks.
 * Search filters by title substring.
 *
 * Two groups, not one: **Benches** (T5) sits above **Recent**, because a
 * bench is a thing you reach for from wherever you are — most often from
 * inside the Modelfile editor, having just saved a change.
 */
import { useState } from "react";
import "./Sidebar.css";
import { relativeTime, shortTag, type ChatSession } from "../chat/sessions";
// T5 / R4 — the Benches group. It lives in app/src/bench/ so the rail's own
// file keeps to one job; the group is above Recent because the rail persists
// across every surface, which is what makes a bench reachable from inside
// the Modelfile editor.
import { BenchmarkRail } from "../benchmark/BenchmarkRail";
import { NewMenu } from "./NewMenu";
import { useTourTarget } from "../tour/registry";
import { useRemuda } from "./state";

function SessionRow({ session, active }: { session: ChatSession; active: boolean }) {
  const { models, openSession, deleteSession } = useRemuda();
  const isLoaded = models.some((m) => m.tag === session.model && m.isLoaded);

  const tag = shortTag(session.model);
  const state = isLoaded ? "loaded" : "not loaded";

  return (
    <div className={active ? "sess active" : "sess"}>
      <button
        type="button"
        className="sess-open"
        onClick={() => openSession(session.id)}
        aria-current={active || undefined}
        title={`${tag}, ${state}`}
      >
        <div className="strow">
          <span className={isLoaded ? "sdot" : "sdot off"} aria-hidden="true" />
          <span className="stitle">{session.title}</span>
          <span className="stime">{relativeTime(session.updatedAt)}</span>
        </div>
        {/* The tag is spelled out on the open chat only — every other row
            carries it in the tooltip and the screen-reader line below. */}
        {active && (
          <div className="smodel" aria-hidden="true">
            <span className={isLoaded ? "smodel-tag" : "smodel-tag off"}>{tag}</span>
          </div>
        )}
        <span className="sr-only">{`${tag}, ${state}`}</span>
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
  const {
    view,
    setView,
    sessions,
    activeSessionId,
    benchmarks,
    activeBenchmarkId,
    openBenchmark,
    createAndOpenBenchmark,
    deleteBenchmark,
  } = useRemuda();
  // R6 step 3 rings the BENCHMARKS header; the rail takes the ref rather
  // than registering it, so tour/steps.ts stays this side of the boundary.
  const benchmarksRef = useTourTarget("benchmark");
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
        <NewMenu />
      </div>
      {/* The rail's + and the "+ New ▸ New benchmark" menu item do exactly the
          same thing: create, then open. Neither is gated on residency. */}
      <BenchmarkRail
        benchmarks={benchmarks}
        activeBenchmarkId={activeBenchmarkId}
        paneVisible={view === "benchmark"}
        onOpen={openBenchmark}
        onCreate={createAndOpenBenchmark}
        onDelete={deleteBenchmark}
        headerRef={benchmarksRef}
      />
      <div className="side-label">Recent</div>
      <div className="sesslist">
        {filtered.length === 0 ? (
          <p className="empty-note">
            {sessions.length === 0
              ? "No chats yet. Start one with + New."
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
