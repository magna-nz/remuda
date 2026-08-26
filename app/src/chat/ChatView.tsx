/**
 * Chat / Test surface (SPEC.md §5.3, §8, §9; docs/mockup.html).
 *
 * Message log (user right, assistant left), streaming caret, warming state
 * before the first token, the composer (Enter sends, Shift+Enter newlines),
 * the note strip, a tok/s readout after a completed reply, and the amber
 * "model unloaded" banner with Load now. Opening a session never silently
 * swaps its model — the banner names it instead.
 */
import { useState, type KeyboardEvent } from "react";
import "./ChatView.css";
import { useRemuda } from "../ui/state";
import { shortTag, type ChatSession } from "./sessions";

/** Two-letter avatar for the assistant, from the model name ("llama3.1" → "Ll"). */
function avatarFor(tag: string): string {
  const name = tag.split(":")[0] ?? tag;
  const letters = name.slice(0, 2);
  return letters.charAt(0).toUpperCase() + letters.slice(1);
}

/** No session open yet: the M1 empty state pointing at the model control. */
function NoSession() {
  return (
    <div className="chat-empty">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <b>Load a model, then start a chat</b>
    </div>
  );
}

/** SPEC §5.3/§9: amber banner when the session's model isn't in memory. */
function UnloadedBanner({ session }: { session: ChatSession }) {
  const { loaded, load } = useRemuda();
  return (
    <div className="chat-banner" role="status">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
      <div className="bt">
        <b>{session.model}</b> isn’t loaded — currently loaded:{" "}
        <code>{loaded ? loaded.variant : "nothing"}</code>. Load it to continue this chat.
      </div>
      <button type="button" className="btn sm" onClick={() => void load(session.model)}>
        Load now
      </button>
    </div>
  );
}

export function ChatView() {
  const {
    sessions,
    activeSessionId,
    models,
    streamingSessionId,
    streamError,
    lastStats,
    sendMessage,
    cancelGeneration,
  } = useRemuda();
  const [draft, setDraft] = useState("");

  const session = sessions.find((s) => s.id === activeSessionId) ?? null;
  if (!session) return <NoSession />;

  const modelIsLoaded = models.some((m) => m.tag === session.model && m.isLoaded);
  const streaming = streamingSessionId !== null;
  const streamingHere = streamingSessionId === session.id;
  const last = session.messages[session.messages.length - 1];
  // SPEC §9: before the first token, "warming up…" instead of an empty bubble.
  const warming = streamingHere && last?.role === "assistant" && last.content === "";

  const submit = () => {
    if (streaming || draft.trim() === "") return;
    const text = draft;
    setDraft("");
    void sendMessage(text);
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter newlines (SPEC §5.3).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="chatmain">
      {!modelIsLoaded && <UnloadedBanner session={session} />}

      {session.messages.length === 0 ? (
        <div className="chat-empty">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <b>New chat</b>
          <div>
            Send a message to test <code className="modeltag">{shortTag(session.model)}</code>.
          </div>
        </div>
      ) : (
        <div className="chatlog">
          {session.messages.map((m, i) => {
            const isLast = i === session.messages.length - 1;
            if (m.role === "assistant" && isLast && warming) {
              return (
                <div key={i} className="msg bot">
                  <div className="av" aria-hidden="true">
                    {avatarFor(session.model)}
                  </div>
                  <div className="bubble warming">
                    warming up <code className="modeltag">{session.model}</code>…
                  </div>
                </div>
              );
            }
            return (
              <div key={i} className={m.role === "user" ? "msg user" : "msg bot"}>
                <div className="av" aria-hidden="true">
                  {m.role === "user" ? "You" : avatarFor(session.model)}
                </div>
                <div className="bubble">
                  {m.content}
                  {m.role === "assistant" && isLast && streamingHere && (
                    <span className="caret" aria-hidden="true" />
                  )}
                </div>
              </div>
            );
          })}
          {!streamingHere && lastStats?.sessionId === session.id && (
            <div className="tokstat">{lastStats.tokPerSec} tok/s</div>
          )}
          {streamError !== null && streamingSessionId === null && (
            <div className="chat-error" role="alert">
              {streamError}
            </div>
          )}
        </div>
      )}

      <div className="composer">
        <div className="box">
          <textarea
            rows={1}
            value={draft}
            placeholder={`Message ${session.model}…`}
            aria-label="Message"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          {streaming ? (
            <button
              type="button"
              className="send stop"
              title="Stop generating"
              aria-label="Stop generating"
              onClick={cancelGeneration}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="7" y="7" width="10" height="10" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="send"
              title="Send"
              aria-label="Send"
              onClick={submit}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
              </svg>
            </button>
          )}
        </div>
        <div className="note-strip">
          Messages here <b>test</b> the loaded model ·{" "}
          <span>they don’t change its saved Modelfile</span>
        </div>
      </div>
    </div>
  );
}
