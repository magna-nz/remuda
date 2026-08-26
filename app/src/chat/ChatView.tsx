/**
 * Chat / Test surface (SPEC.md §5.3, §8, §9; docs/mockup-proposals.html §02–§05).
 *
 * Message log (user right, assistant left), streaming caret, warming state
 * before the first token, the composer (Enter sends, Shift+Enter newlines),
 * the note strip, the full timings strip after a completed reply, and the
 * amber "model unloaded" banner with Load now. Opening a session never
 * silently swaps its model — the banner names it instead.
 *
 * Three things here are gated on the session model's `capabilities`, and the
 * gate is deliberately one-sided: an empty `capabilities` array means the
 * server didn't say (older Ollama, or the /api/tags-only path), not that the
 * model can't. So absence degrades to today's plain chat; only a non-empty
 * list that lacks `completion` locks the composer.
 *
 *   thinking   → the think-level segmented control
 *   vision     → the paperclip, paste and drop
 *   completion → the composer itself (an embedding model gets an explanation)
 */
import { useEffect, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import "./ChatView.css";
import { useRemuda, type LastStats } from "../ui/state";
import type { Model, ThinkLevel } from "../api/types";
import { shortTag, type ChatSession } from "./sessions";
import { ThinkingBlock } from "./ThinkingBlock";
import {
  RunControls,
  RunControlsPill,
  countOverrides,
  describeOverrides,
  groupDigits,
} from "./RunControls";
import {
  AttachButton,
  MessageAttachments,
  PendingAttachments,
  imageFilesFrom,
  readImageFiles,
  type PendingImage,
} from "./Attachments";

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

/**
 * A model whose capabilities lack `completion` can't hold a chat. Say so up
 * front rather than letting the first message fail (mockup §02, right half).
 */
function EmbeddingGate({ tag }: { tag: string }) {
  return (
    <>
      <div className="gate" role="note">
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
        <div>
          <b>{tag} is an embedding model.</b>
          <p>
            It has no <code>completion</code> capability, so it can’t hold a chat. It’s still
            loadable — Remuda just won’t offer you a composer for it.
          </p>
        </div>
      </div>
      <div className="gate-foot">
        <div>
          Pick a model with <code>completion</code> to start a chat.
        </div>
      </div>
    </>
  );
}

/** ms → "2.41 s"; null (server didn't report it) → an em dash, never NaN. */
function secondsCell(ms: number | null) {
  if (ms === null) return <>—</>;
  return (
    <>
      {(ms / 1000).toFixed(2)} <small>s</small>
    </>
  );
}

/**
 * The full `--verbose` readout under a completed reply (mockup §04).
 * Ollama's final chunk carries six timing fields; Remuda used to render two
 * of them. Every one of these is optional on the wire — null means "the
 * server didn't say", and renders as —.
 */
function StatsStrip({ stats, contextLength }: { stats: LastStats; contextLength: number | null }) {
  return (
    <div className="stats" aria-label="Reply timings">
      <div className="s">
        <div className="k">Generation</div>
        <div className="v">
          {stats.tokPerSec} <small>tok/s</small>
        </div>
      </div>
      <div className="s">
        <div className="k">Prompt eval</div>
        <div className="v">
          {stats.promptTokPerSec === null ? (
            <>—</>
          ) : (
            <>
              {groupDigits(stats.promptTokPerSec)} <small>tok/s</small>
            </>
          )}
        </div>
      </div>
      <div className="s">
        <div className="k">Load</div>
        <div className="v">{secondsCell(stats.loadMs)}</div>
      </div>
      <div className="s">
        <div className="k">Total</div>
        <div className="v">{secondsCell(stats.totalMs)}</div>
      </div>
      <div className="s">
        <div className="k">Context used</div>
        <div className="v">
          {stats.contextTokens === null ? (
            <>—</>
          ) : (
            <>
              {groupDigits(stats.contextTokens)}
              {contextLength !== null && <small> / {groupDigits(contextLength)}</small>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const THINK_LEVELS: { value: ThinkLevel; label: string }[] = [
  { value: "off", label: "off" },
  { value: "low", label: "low" },
  { value: "medium", label: "med" },
  { value: "high", label: "high" },
];

export function ChatView() {
  const {
    sessions,
    activeSessionId,
    models,
    running,
    streamingSessionId,
    streamError,
    lastStats,
    sendMessage,
    cancelGeneration,
    setSessionOptions,
    setSessionThink,
    bakeOptionsIntoEditor,
  } = useRemuda();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [runOpen, setRunOpen] = useState(false);
  const [dropping, setDropping] = useState(false);

  const session = sessions.find((s) => s.id === activeSessionId) ?? null;
  const sessionId = session?.id ?? null;

  // Staged attachments and an open popover belong to the chat you were in.
  useEffect(() => {
    setPending([]);
    setRunOpen(false);
    setDropping(false);
  }, [sessionId]);

  if (!session) return <NoSession />;

  const model: Model | null = models.find((m) => m.tag === session.model) ?? null;
  const capabilities = model?.capabilities ?? [];
  // Absence of evidence is not evidence of absence: an empty list means the
  // server didn't report capabilities, so chat stays available.
  const canChat = capabilities.length === 0 || capabilities.includes("completion");
  const canThink = capabilities.includes("thinking");
  const canSee = capabilities.includes("vision");

  const modelIsLoaded = models.some((m) => m.tag === session.model && m.isLoaded);
  const streaming = streamingSessionId !== null;
  const streamingHere = streamingSessionId === session.id;
  const last = session.messages[session.messages.length - 1];
  // SPEC §9: before the first token, "warming up…" instead of an empty bubble.
  const warming = streamingHere && last?.role === "assistant" && last.content === "";
  const stats = !streamingHere && lastStats?.sessionId === session.id ? lastStats : null;
  const overrides = session.options ?? {};
  const overrideCount = countOverrides(overrides);
  const think: ThinkLevel = session.think ?? "off";
  // num_ctx is load-time, not sampling (SPEC §5.1): once it is overridden the
  // warning follows the composer, not just the popover it was set in.
  //
  // What decides whether a reload happens is the context the *runner* was
  // started with (/api/ps), NOT the model's trained maximum (/api/show).
  // Comparing against the maximum gets it wrong in both directions: a model
  // whose Modelfile pins num_ctx below its ceiling would show no warning for
  // an override set to that ceiling — the one case that really does reload —
  // and would warn for an override equal to what the runner is already using.
  // With nothing resident there is no reload to warn about; the next message
  // simply loads at the requested size.
  const runningCtx = running.find((r) => r.tag === session.model)?.contextLength ?? null;
  const ctxReloads =
    overrides.numCtx !== undefined && runningCtx !== null && overrides.numCtx !== runningCtx;

  const hasSomethingToSend = draft.trim() !== "" || pending.length > 0;

  const submit = () => {
    // An image is a message. Requiring text as well made "attach a
    // screenshot and hit send" a silent no-op with the button still enabled.
    if (streaming || !hasSomethingToSend) return;
    const text = draft;
    const images = pending.map((p) => p.base64);
    const thumbs = pending.map((p) => p.thumb);
    setDraft("");
    setPending([]);
    void sendMessage(
      text,
      images.length > 0 ? images : undefined,
      thumbs.length > 0 ? thumbs : undefined,
    );
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter newlines (SPEC §5.3).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const addFiles = (files: File[]) => {
    if (!canSee || files.length === 0) return;
    void readImageFiles(files).then((items) => {
      if (items.length > 0) setPending((prev) => [...prev, ...items]);
    });
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canSee) return;
    const files = imageFilesFrom(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!canSee || !canChat) return;
    e.preventDefault();
    setDropping(true);
  };

  // Moving between children re-fires dragleave on the container; only a
  // pointer that actually left clears the highlight.
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    setDropping(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!canSee || !canChat) return;
    e.preventDefault();
    setDropping(false);
    addFiles(imageFilesFrom(e.dataTransfer));
  };

  return (
    <div
      className={`chatmain${dropping ? " dropping" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {!modelIsLoaded && <UnloadedBanner session={session} />}
      {!canChat && <EmbeddingGate tag={session.model} />}

      {canChat &&
        (session.messages.length === 0 ? (
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
                    <div className="col">
                      {m.thinking !== undefined && m.thinking !== "" && (
                        <ThinkingBlock text={m.thinking} live={streamingHere} />
                      )}
                      <div className="bubble warming">
                        warming up <code className="modeltag">{session.model}</code>…
                      </div>
                    </div>
                  </div>
                );
              }
              const thumbs = m.imageThumbs ?? [];
              return (
                <div key={i} className={m.role === "user" ? "msg user" : "msg bot"}>
                  <div className="av" aria-hidden="true">
                    {m.role === "user" ? "You" : avatarFor(session.model)}
                  </div>
                  <div className="col">
                    {/* Reasoning sits outside the bubble — machinery, not the
                        answer, and not part of a copied reply. */}
                    {m.role === "assistant" && m.thinking !== undefined && m.thinking !== "" && (
                      <ThinkingBlock
                        text={m.thinking}
                        // Ollama streams all reasoning before any content, so
                        // the first content token is when thinking ended.
                        // Leaving `live` true for the whole reply made the
                        // header report the reply's duration as the thinking
                        // time — wrong by the length of the answer.
                        live={isLast && streamingHere && m.content === ""}
                      />
                    )}
                    {m.role === "user" && thumbs.length > 0 && (
                      <MessageAttachments thumbs={thumbs} full={m.images !== undefined} />
                    )}
                    <div className="bubble">
                      {m.content}
                      {m.role === "assistant" && isLast && streamingHere && (
                        <span className="caret" aria-hidden="true" />
                      )}
                    </div>
                    {m.role === "assistant" && isLast && stats !== null && (
                      <>
                        <StatsStrip
                          stats={stats}
                          // The runner's context, not the trained ceiling:
                          // "5 000 / 262 144" while the runner sits at 32 768
                          // misreports how close the chat is to filling up.
                          contextLength={runningCtx ?? model?.contextLength ?? null}
                        />
                        {overrideCount > 0 && (
                          <div className="runnote">
                            {describeOverrides(overrides)} — set for this chat
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {streamError !== null && streamingSessionId === null && (
              <div className="chat-error" role="alert">
                {streamError}
              </div>
            )}
          </div>
        ))}

      {canChat && (
        <div className="composer">
          {runOpen && (
            <RunControls
              options={overrides}
              modelContextLength={model?.contextLength ?? null}
              runningContextLength={runningCtx}
              onChange={(next) => setSessionOptions(session.id, next)}
              onClose={() => setRunOpen(false)}
              onBake={() => {
                setRunOpen(false);
                // Opens the Modelfile AND writes the overrides in, rather
                // than navigating to an empty editor and dropping them.
                void bakeOptionsIntoEditor(session.model, overrides);
              }}
            />
          )}
          {canSee && (
            <PendingAttachments
              items={pending}
              onRemove={(id) => setPending((prev) => prev.filter((p) => p.id !== id))}
            />
          )}
          <div className="box">
            {canSee && (
              <AttachButton modelTag={session.model} disabled={streaming} onFiles={addFiles} />
            )}
            <textarea
              rows={1}
              value={draft}
              placeholder={`Message ${session.model}…`}
              aria-label="Message"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKeyDown}
              onPaste={onPaste}
            />
            {streamingHere ? (
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
                title={streaming ? "Another chat is still generating" : "Send"}
                aria-label="Send"
                onClick={submit}
                disabled={streaming}
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
            {canThink && (
              <span className="seg" role="group" aria-label="Think">
                <span className="lbl">Think</span>
                {THINK_LEVELS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    className={think === value ? "on" : undefined}
                    aria-pressed={think === value}
                    onClick={() => setSessionThink(session.id, value)}
                  >
                    {label}
                  </button>
                ))}
              </span>
            )}
            <RunControlsPill
              count={overrideCount}
              open={runOpen}
              onToggle={() => setRunOpen((v) => !v)}
            />
            {ctxReloads && overrides.numCtx !== undefined && (
              <span className="ctx-chip" title="Context length is applied at load time">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                </svg>
                num_ctx {groupDigits(overrides.numCtx)} — the next message reloads the model
              </span>
            )}
            {canSee && <span className="hint">drop an image in the log, or ⌘V</span>}
            <span className="spacer" />
            <span className="note">
              Messages here <b>test</b> the loaded model ·{" "}
              <span>they don’t change its saved Modelfile</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
