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
import { pasteChord } from "../ui/platform";
import type { Model, ThinkLevel } from "../api/types";
import { shortTag, type ChatSession, type Lane, type Message } from "./sessions";
import { ThinkingBlock } from "./ThinkingBlock";
import {
  RunControls,
  RunControlsPill,
  countOverrides,
  describeOverrides,
  groupDigits,
} from "./RunControls";
// T2 — A/B compare (docs/SPEC-tuning.md, docs/mockup-tuning.html #t2).
import {
  LANES,
  effectiveLaneOptions,
  historyForLane,
  laneChipLabel,
  laneConfig,
  randomSeed,
  swapsModel,
  winnerBy,
} from "./compare";
// T6 items 1–3 — the reply overflow menu (mockup-tuning #t6, card 2).
import { ReplyMenu, copyText } from "./ReplyMenu";
import { asCurl, asOllamaRun, type ExportInput } from "./exportRequest";
// R2 — constrained output (docs/SPEC-round-two.md, mockup-proposals-2 §02).
import { FormatPane, FormatPill } from "../format/FormatPane";
import { ConformanceCard } from "../format/ConformanceCard";
import { defaultFormat, parseSchema, wireFormat } from "../format/format";
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
  // Several models can be resident at once, so "what *is* loaded" is a list.
  // Naming them all is the useful form: the reason this session's model
  // isn't in memory is usually that other ones are.
  const residents = loaded.map((l) => l.variant);
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
        <b>{session.model}</b> isn’t loaded — in memory:{" "}
        {residents.length === 0 ? (
          <code>nothing</code>
        ) : (
          residents.map((tag, i) => (
            <span key={tag}>
              {i > 0 && ", "}
              <code>{tag}</code>
            </span>
          ))
        )}
        . Load it to continue this chat.
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

/* ── A/B lanes (docs/SPEC-tuning.md T2) ───────────────────────────────── */

/** The metrics a lane can win. Deliberately not summed — see `winnerBy`. */
type LaneMetric = "gen" | "prompt" | "total";

function laneWinners(
  a: LastStats | null,
  b: LastStats | null,
): Record<LaneMetric, Lane | null> {
  return {
    gen: winnerBy(a?.tokPerSec, b?.tokPerSec, "higher"),
    prompt: winnerBy(a?.promptTokPerSec, b?.promptTokPerSec, "higher"),
    // Wall time: less is better, and it is the one metric where that flips.
    total: winnerBy(a?.totalMs, b?.totalMs, "lower"),
  };
}

/**
 * One lane's four numbers, in fixed grid positions.
 *
 * The positions are the point: two lanes' figures are only comparable at a
 * glance if `gen` sits above `gen`. So every cell renders whether or not the
 * server reported it — an absent number is an em dash holding its place, not
 * a missing row that shifts the other three up and misaligns the footers.
 *
 * The win marker is per metric and there is no total. "Which is better" is
 * the judgement the user is here to make.
 */
function LaneStats({
  lane,
  stats,
  wins,
}: {
  lane: Lane;
  stats: LastStats | null;
  wins: Record<LaneMetric, Lane | null>;
}) {
  const cls = (metric: LaneMetric) => `stat${wins[metric] === lane ? " win" : ""}`;
  return (
    <div className="lanestats" aria-label={`Lane ${lane.toUpperCase()} timings`}>
      <span className={cls("gen")}>
        gen <b>{stats === null ? "—" : `${stats.tokPerSec} tok/s`}</b>
      </span>
      <span className={cls("prompt")}>
        prompt{" "}
        <b>
          {stats?.promptTokPerSec == null ? "—" : `${groupDigits(stats.promptTokPerSec)} tok/s`}
        </b>
      </span>
      <span className={cls("total")}>
        total <b>{stats?.totalMs == null ? "—" : `${(stats.totalMs / 1000).toFixed(2)} s`}</b>
      </span>
      {/* Unmarked on purpose: a longer answer is not a better one. */}
      <span className="stat">out <b>{stats === null ? "—" : `${stats.evalCount} tok`}</b></span>
    </div>
  );
}

interface LaneSlot {
  message: Message;
  /** Position in the transcript — what the export needs to rebuild history. */
  index: number;
}

type Row =
  | { kind: "single"; key: string; index: number; message: Message }
  | { kind: "lanes"; key: string; a: LaneSlot | null; b: LaneSlot | null };

/**
 * Group the transcript into rows: unlaned messages full width, and each
 * turn's two lane replies side by side.
 *
 * A turn is "the run of laned messages that hasn't filled this lane yet",
 * which is what keeps two consecutive compare turns from collapsing into one
 * row, and what lets a half-finished pair (lane A written, lane B cancelled
 * before it started) still render as a pair with one side empty.
 */
function toRows(messages: Message[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const lane = message.lane;
    if (lane === undefined) {
      rows.push({ kind: "single", key: `m${i}`, index: i, message });
      continue;
    }
    const last = rows[rows.length - 1];
    if (last !== undefined && last.kind === "lanes" && last[lane] === null) {
      last[lane] = { message, index: i };
    } else {
      rows.push({
        kind: "lanes",
        key: `m${i}`,
        a: lane === "a" ? { message, index: i } : null,
        b: lane === "b" ? { message, index: i } : null,
      });
    }
  }
  return rows;
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
    keepAlive,
    streamingSessionId,
    streamError,
    errorsByMessage,
    lastStats,
    statsByMessage,
    compareRun,
    benchProgress,
    sendMessage,
    cancelGeneration,
    setSessionOptions,
    setSessionThink,
    setSessionFormat,
    bakeOptionsIntoEditor,
    toggleCompare,
    setLaneConfig,
    setPinnedSeed,
    sendCompare,
    keepLane,
    regenerateReply,
    promoteToSystem,
    addToBench,
  } = useRemuda();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [runOpen, setRunOpen] = useState(false);
  // The Format pane (R2). Open/closed is per view, like the run popover;
  // what it edits is per *session* and persisted there.
  const [formatOpen, setFormatOpen] = useState(false);
  // Per lane, not per turn: a lane's overrides are one set of values, and the
  // popover that edits them is anchored to the composer like the single-lane
  // one. Both may be open at once — comparing two knob panels side by side is
  // the whole point, and RunControls' `scope` is what makes that addressable.
  const [laneRunOpen, setLaneRunOpen] = useState<Record<Lane, boolean>>({ a: false, b: false });
  // One reply menu open at a time, keyed by message id.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const session = sessions.find((s) => s.id === activeSessionId) ?? null;
  const sessionId = session?.id ?? null;

  // Staged attachments and an open popover belong to the chat you were in.
  useEffect(() => {
    setPending([]);
    setRunOpen(false);
    setFormatOpen(false);
    setLaneRunOpen({ a: false, b: false });
    setMenuFor(null);
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
  const compare = session.compare;
  const compareHere = compareRun !== null && compareRun.sessionId === session.id;
  // A compare run holds the app-wide guard across the gap between its lanes,
  // so "something is generating" is the union of the two.
  // A bench replay is a generation like any other, and SPEC §8's "one at a
  // time" is enforced app-wide in the store. Leaving it out here left Send
  // enabled through a replay that can run for minutes: the store refused the
  // send and the composer said nothing, so the message just sat there.
  const streaming =
    streamingSessionId !== null || compareRun !== null || benchProgress !== null;
  const streamingHere = streamingSessionId === session.id;
  const busyHere = streamingHere || compareHere;
  const last = session.messages[session.messages.length - 1];
  // SPEC §9: before the first token, "warming up…" instead of an empty bubble.
  const warming =
    streamingHere && last?.role === "assistant" && last.lane === undefined && last.content === "";
  const stats = !streamingHere && lastStats?.sessionId === session.id ? lastStats : null;
  const overrides = session.options ?? {};
  const overrideCount = countOverrides(overrides);
  const think: ThinkLevel = session.think ?? "off";
  // R2 — constrained output. Everything about it is derived on render from
  // the session's raw text: the schema the card judges against, and whether
  // the send can happen at all. Nothing is cached, so fixing the schema
  // re-judges every reply already on screen.
  const format = session.format ?? defaultFormat();
  const formatSchema = format.mode === "schema" ? parseSchema(format.text).schema : null;
  const formatBroken = wireFormat(session.format).error !== null;
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
    // R2: refuse rather than send unconstrained — and refuse *before* the
    // draft is cleared, so a broken schema costs the user the send and not
    // what they typed. The pane opens on the error, which is where it can
    // be fixed; ui/state.tsx refuses again as the backstop.
    if (formatBroken) {
      setFormatOpen(true);
      return;
    }
    const text = draft;
    const images = pending.map((p) => p.base64);
    const thumbs = pending.map((p) => p.thumb);
    setDraft("");
    setPending([]);
    const send = compare === undefined ? sendMessage : sendCompare;
    void send(
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

  /**
   * The exact request that produced (or would re-produce) one reply.
   *
   * Rebuilt from the same three things the send path used — the history
   * before the reply, the configuration that ran it, and the keep_alive in
   * effect — so "Copy as curl" hands over what was actually sent rather than
   * a plausible-looking reconstruction. A lane reply is rebuilt against its
   * own lane's history, because that is the conversation it answered.
   */
  const exportFor = (message: Message, index: number): ExportInput => {
    const lane = message.lane;
    if (lane !== undefined && compare !== undefined) {
      const config = laneConfig(compare, lane);
      return {
        tag: config.model,
        messages: historyForLane(session.messages.slice(0, index), lane),
        options: effectiveLaneOptions(compare, lane),
        think: config.think,
        keepAlive,
        // Per-chat, so a lane's exported request carries it too.
        format: wireFormat(session.format).format,
      };
    }
    return {
      tag: session.model,
      messages:
        lane === undefined
          ? session.messages.slice(0, index)
          : historyForLane(session.messages.slice(0, index), lane),
      options: session.options,
      think: session.think,
      keepAlive,
      format: wireFormat(session.format).format,
    };
  };

  /**
   * The conformance card under one reply (R2).
   *
   * Only for a finished reply: mid-stream the text is a prefix of the
   * object, which is indistinguishable from the truncation the card exists
   * to report — it would say "cut off" about every reply, right up until it
   * wasn't. `off` has nothing to judge against and shows nothing.
   */
  const formatCard = (text: string, finished: boolean, constrained: boolean) => {
    // `constrained` is recorded on the message when it was generated, so
    // switching a schema on does not retroactively put a red "not valid
    // JSON" verdict under prose that was never asked to be JSON.
    if (!finished || !constrained || format.mode === "off" || text.trim() === "") return null;
    return (
      <ConformanceCard text={text} schema={formatSchema} numPredict={overrides.numPredict} />
    );
  };

  /** The overflow menu for one reply (T6 items 1–3). */
  const replyMenu = (message: Message, index: number, name: string) => {
    const input = exportFor(message, index);
    const seed = input.options?.seed ?? null;
    const id = message.id;
    return (
      <ReplyMenu
        name={name}
        open={menuFor !== null && menuFor === id}
        onToggle={() => setMenuFor((prev) => (prev === id ? null : (id ?? null)))}
        onClose={() => setMenuFor(null)}
        seed={seed}
        // No id means a session written before ids were persisted: there is
        // nothing to stream a re-roll back into, so the item stays off.
        busy={streaming || id === undefined}
        onPromote={() => void promoteToSystem(message.content)}
        onRegenerateSameSeed={() => {
          if (id !== undefined) void regenerateReply(session.id, id);
        }}
        onRegenerateNewSeed={() => {
          if (id !== undefined) void regenerateReply(session.id, id, randomSeed(seed ?? undefined));
        }}
        onCopyCurl={() => void copyText(asCurl(input))}
        onCopyOllamaRun={() => void copyText(asOllamaRun(input))}
      />
    );
  };

  /**
   * The menu on a *user* message (T5 capture).
   *
   * Deliberately its own thing rather than a widened `replyMenu`: none of
   * that menu's items mean anything on a prompt — there is no reply to
   * re-roll, promote or export — so it carries the one item that does, and
   * says "Prompt actions" rather than claiming to act on a reply.
   */
  const promptMenu = (message: Message, index: number) => {
    const id = message.id ?? `u-${index}`;
    return (
      <ReplyMenu
        name={`for prompt ${index + 1}`}
        label="Prompt actions"
        open={menuFor === id}
        onToggle={() => setMenuFor((prev) => (prev === id ? null : id))}
        onClose={() => setMenuFor(null)}
        busy={streaming}
        onAddToBench={() => {
          addToBench(message.content);
          setMenuFor(null);
        }}
      />
    );
  };

  /** One full-width message — the single-lane transcript, unchanged. */
  const renderMessage = (m: Message, i: number) => {
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
        {m.role === "assistant" && (
          <div className="av" aria-hidden="true">
            {avatarFor(session.model)}
          </div>
        )}
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
          {m.role === "assistant" &&
            formatCard(m.content, !(isLast && streamingHere), m.constrained === true)}
          {m.role === "assistant" && (
            <div className="msgfoot">{replyMenu(m, i, `for message ${i + 1}`)}</div>
          )}
          {m.role === "user" && <div className="msgfoot">{promptMenu(m, i)}</div>}
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
  };

  /** One lane of one compare turn (mockup-tuning #t2: .lane). */
  const renderLane = (
    row: Extract<Row, { kind: "lanes" }>,
    lane: Lane,
    turn: number,
    isLastRow: boolean,
    wins: Record<LaneMetric, Lane | null>,
  ) => {
    const slot = lane === "a" ? row.a : row.b;
    const message = slot?.message ?? null;
    const config = compare === undefined ? null : laneConfig(compare, lane);
    const laneStats =
      message?.id !== undefined ? (statsByMessage[message.id] ?? null) : null;
    const laneError = message?.id !== undefined ? errorsByMessage[message.id] : undefined;
    // Only the newest row can be live; an older turn is finished by definition.
    const run = compareHere && isLastRow ? compareRun : null;
    const generating = run !== null && run.lane === lane;
    const content = message?.content ?? "";
    const thinking = message?.thinking ?? "";
    // Sequential lanes (SPEC §8): B waits for A, and says so rather than
    // sitting blank as though it had answered with nothing.
    const queued = run !== null && run.lane === "a" && lane === "b" && content === "";
    const warmingLane = generating && content === "" && thinking === "";
    const upper = lane.toUpperCase();

    return (
      <div className={`lane ${lane}`} key={lane}>
        <div className="lanehead">
          <span className="lanetag" aria-hidden="true">
            {upper}
          </span>
          {isLastRow && config !== null ? (
            // The chip is the lane's whole identity (T2), shown only on the
            // newest turn: a past turn's configuration was never recorded, so
            // a chip there would be labelling old output with today's
            // settings. The one you can *click* lives in the compare bar,
            // once per lane rather than once per turn.
            <span className="cfgchip">{laneChipLabel(config)}</span>
          ) : (
            <span className="lanename">Lane {upper}</span>
          )}
          <span className="spacer" />
          {message !== null && replyMenu(message, slot?.index ?? 0, `for lane ${upper}, turn ${turn}`)}
        </div>
        {thinking !== "" && <ThinkingBlock text={thinking} live={generating && content === ""} />}
        {queued ? (
          <div className="lanebody queued">queued</div>
        ) : warmingLane ? (
          <div className="lanebody queued">
            warming up <code className="modeltag">{config?.model ?? session.model}</code>…
          </div>
        ) : (
          <div className="lanebody">
            {content}
            {generating && <span className="caret" aria-hidden="true" />}
            {/*
             * This lane's own failure. The app-wide `streamError` is a single
             * slot the sibling lane clears when it starts, so without an
             * addressable copy a failed lane renders as an empty bubble with
             * the explanation discarded.
             */}
            {laneError !== undefined && (
              <p className="lane-error" role="status">
                {laneError}
              </p>
            )}
            {/* `format` is per-chat, so both lanes were decoded under the
                same constraint and both are judged against it. */}
            {formatCard(content, !generating, message?.constrained === true)}
          </div>
        )}
        <LaneStats lane={lane} stats={laneStats} wins={wins} />
        {isLastRow && (
          <div className="lanefoot">
            <button
              type="button"
              className={`btn sm${lane === "a" ? " primary" : ""}`}
              // The two buttons read the same and do opposite things, so the
              // accessible name has to say which side "this" is.
              aria-label={`Keep lane ${upper}`}
              disabled={streaming}
              onClick={() => keepLane(session.id, lane)}
            >
              Keep this side
            </button>
            <span className="lanemodel">{shortTag(config?.model ?? session.model)}</span>
          </div>
        )}
      </div>
    );
  };

  const rows = compare === undefined ? null : toRows(session.messages);
  let turn = 0;

  const body = (
    <div
      className={`chatmain${dropping ? " dropping" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {canChat && (
        <div className="chathead">
          {/* No session title here on purpose — the sidebar already names the
              chat, and a second copy in the main column is a second thing to
              keep in sync for no gain. */}
          <span className="spacer" />
          <button
            type="button"
            className={`cmpbtn${compare === undefined ? "" : " on"}`}
            aria-label="Compare"
            aria-pressed={compare !== undefined}
            title="Run one prompt against two configurations"
            onClick={() => {
              // The popovers belong to the mode they were opened in: the
              // session-level one has no pill to close it while compare is
              // on, and the lane ones have no lanes once it is off.
              setRunOpen(false);
              setLaneRunOpen({ a: false, b: false });
              toggleCompare(session.id);
            }}
          >
            ⇄ Compare{compare === undefined ? "" : " · on"}
          </button>
        </div>
      )}
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
            {rows === null
              ? session.messages.map((m, i) => renderMessage(m, i))
              : rows.map((row, ri) => {
                  if (row.kind === "single") return renderMessage(row.message, row.index);
                  turn += 1;
                  const isLastRow = ri === rows.length - 1;
                  const statsA =
                    row.a?.message.id !== undefined
                      ? (statsByMessage[row.a.message.id] ?? null)
                      : null;
                  const statsB =
                    row.b?.message.id !== undefined
                      ? (statsByMessage[row.b.message.id] ?? null)
                      : null;
                  const wins = laneWinners(statsA, statsB);
                  return (
                    <div key={row.key}>
                      <div className="sharedtag">one prompt · both lanes</div>
                      <div className="lanes">
                        {LANES.map((lane) => renderLane(row, lane, turn, isLastRow, wins))}
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

      {canChat && compare !== undefined && (
        <div className="cmpbar">
          {LANES.map((lane) => {
            const upper = lane.toUpperCase();
            const config = laneConfig(compare, lane);
            return (
              <span key={lane} className="lanepick">
                <span className="lanetag" aria-hidden="true">
                  {upper}
                </span>
                <select
                  aria-label={`Lane ${upper} model`}
                  value={config.model}
                  disabled={streaming}
                  onChange={(e) => {
                    const tag = e.target.value;
                    setLaneConfig(session.id, lane, {
                      model: tag,
                      modelfile:
                        models.find((m) => m.tag === tag)?.isVariant === true ? tag : null,
                    });
                  }}
                >
                  {models.map((m) => (
                    <option key={m.tag} value={m.tag}>
                      {m.tag}
                    </option>
                  ))}
                </select>
                {/* Reachable before the first send: a comparison you can only
                    configure after running it once is configured too late. */}
                <button
                  type="button"
                  className="cfgchip"
                  aria-label={`Lane ${upper} configuration`}
                  aria-expanded={laneRunOpen[lane]}
                  onClick={() => setLaneRunOpen((prev) => ({ ...prev, [lane]: !prev[lane] }))}
                >
                  {laneChipLabel(config)}
                </button>
              </span>
            );
          })}
          <span className="spacer" />
          {compare.seed === null ? (
            <button
              type="button"
              className="pin calm"
              title="Two configurations under two different seeds measure sampling noise"
              onClick={() => setPinnedSeed(session.id, randomSeed())}
            >
              seeds not pinned · pin one
            </button>
          ) : (
            <button
              type="button"
              className="pin"
              title="Unpin the shared seed and let each lane use its own"
              onClick={() => setPinnedSeed(session.id, null)}
            >
              seed {compare.seed} · pinned for this run
            </button>
          )}
          {swapsModel(compare) ? (
            <span className="pin warn" role="status">
              swaps model between lanes · slower first run
            </span>
          ) : (
            <span className="pin calm">same model · no swap</span>
          )}
          {compareHere && (
            <button type="button" className="btn sm" onClick={cancelGeneration}>
              Cancel run
            </button>
          )}
        </div>
      )}

      {canChat && (
        <div className="composer">
          {runOpen && compare === undefined && (
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
          {compare !== undefined && (laneRunOpen.a || laneRunOpen.b) && (
            <div className="lanepops">
              {LANES.filter((lane) => laneRunOpen[lane]).map((lane) => {
                const config = laneConfig(compare, lane);
                const laneModel = models.find((m) => m.tag === config.model) ?? null;
                const laneRunningCtx =
                  running.find((r) => r.tag === config.model)?.contextLength ?? null;
                return (
                  <RunControls
                    key={lane}
                    scope={`Lane ${lane.toUpperCase()}`}
                    options={config.options ?? {}}
                    modelContextLength={laneModel?.contextLength ?? null}
                    runningContextLength={laneRunningCtx}
                    onChange={(next) => setLaneConfig(session.id, lane, { options: next })}
                    onClose={() => setLaneRunOpen((prev) => ({ ...prev, [lane]: false }))}
                    onBake={() => {
                      setLaneRunOpen((prev) => ({ ...prev, [lane]: false }));
                      void bakeOptionsIntoEditor(config.model, config.options ?? {});
                    }}
                  />
                );
              })}
            </div>
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
              placeholder={
                compare === undefined ? `Message ${session.model}…` : "Message both lanes…"
              }
              aria-label="Message"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKeyDown}
              onPaste={onPaste}
            />
            {busyHere ? (
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
                title={
                  streaming
                    ? "Another chat is still generating"
                    : formatBroken
                      ? "The response schema doesn’t parse — fix it in the Format pane, or switch it off"
                      : "Send"
                }
                aria-label="Send"
                onClick={submit}
                // R2: an unparseable schema refuses the send. The alternative
                // is a request without the constraint the user asked for.
                disabled={streaming || formatBroken}
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
            {/* In compare mode the lanes own the configuration, and a
                session-level pill beside them would name overrides that no
                request will carry. */}
            {canThink && compare === undefined && (
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
            {compare === undefined && (
              <RunControlsPill
                count={overrideCount}
                open={runOpen}
                onToggle={() => setRunOpen((v) => !v)}
              />
            )}
            {/* Shown in compare mode too, unlike Run controls: `format` is
                per-chat and not per-lane, so it is not a lane's to own. */}
            <FormatPill
              config={session.format}
              open={formatOpen}
              onToggle={() => setFormatOpen((v) => !v)}
            />
            {compare === undefined && ctxReloads && overrides.numCtx !== undefined && (
              <span className="ctx-chip" title="Context length is applied at load time">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                </svg>
                num_ctx {groupDigits(overrides.numCtx)} — the next message reloads the model
              </span>
            )}
            {canSee && <span className="hint">drop an image in the log, or {pasteChord()}</span>}
          </div>
        </div>
      )}
    </div>
  );

  // The pane sits beside the chat rather than over it (mockup §02): a
  // schema you are editing to fix a reply has to stay visible next to the
  // reply. Closed, it adds no wrapper at all.
  if (!formatOpen) return body;
  return (
    <div className="fmtsplit">
      <FormatPane
        config={format}
        onChange={(next) => setSessionFormat(session.id, next)}
        onClose={() => setFormatOpen(false)}
      />
      {body}
    </div>
  );
}
