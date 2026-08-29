/**
 * The tool-calling playground (docs/SPEC-tuning.md T3, docs/mockup-tuning.html
 * `#t3`).
 *
 * Split pane: the raw JSON tool schema on the left, the transcript on the
 * right. The surface that matters is the **tool-call card** — function name,
 * a matched / no-such-tool badge, every supplied argument badged against the
 * schema the user wrote, the required keys the model omitted listed
 * separately, and a box to stub the tool's result and continue the run. The
 * validator (validate.ts) is the feature; this file is its display.
 *
 * Two deliberate choices, both about staying out of the shared store:
 *
 * - **The transcript is local state.** This is a playground, not a saved
 *   chat: nothing here is a ChatSession, nothing shows in the chats rail, and
 *   nothing survives a reload. Keeping it here means the pane needs no slice
 *   of ui/state.tsx, no persistence, and no reply-routing — and the "one
 *   streamed generation at a time" policy (SPEC §8) still holds because this
 *   pane sends only while its own send is idle. What it costs is that
 *   switching tabs mid-run abandons the run; the tool sets, which are the
 *   part worth keeping, *are* persisted.
 * - **Verdicts are recomputed on render**, never stored. Editing the schema
 *   re-judges every call already on screen, which is exactly the loop this
 *   feature exists for: you find a malformed call, fix the schema, and see
 *   whether it was the model or the schema that was wrong.
 */
import "./ToolsView.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ToolCall } from "../api/types";
import { PaneHelp, PaneHelpToggle } from "../help/PaneHelp";
import { useRemuda } from "../ui/state";
import { toolCapableModel } from "./gate";
import { loadToolSets, parseTools, saveToolSets, type ToolSet } from "./toolsets";
import { tally, validateCall, type CallVerdict } from "./validate";

/**
 * One transcript entry. `role: "tool"` is the wire role for a stubbed tool
 * result; api/types.ts's ChatMessage does not carry it yet (that file belongs
 * to the API layer, not this pane), so the outbound history is widened at the
 * one call site below and nowhere else.
 */
interface PlayMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** Assistant only. Ollama delivers `arguments` parsed; never JSON.parse it. */
  toolCalls?: ToolCall[];
  /** Tool only: which tool this result answers. */
  toolName?: string;
}

function newId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** How a JSON value reads in an argument row. */
function valueText(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function ToolsView() {
  const { client, models, activeModel, keepAlive } = useRemuda();
  const model = toolCapableModel(models, activeModel);

  const [sets, setSets] = useState<ToolSet[]>(loadToolSets);
  // "" means "whichever set is first" — one less thing to keep in sync when
  // the stored list turns out to be empty and the starters stand in.
  const [activeSetId, setActiveSetId] = useState<string>("");
  const [messages, setMessages] = useState<PlayMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the pane abandons the run rather than streaming into a component
  // that is gone. See the header note: this transcript is not persisted.
  useEffect(() => () => abortRef.current?.abort(), []);

  const activeSet = sets.find((s) => s.id === activeSetId) ?? sets[0] ?? null;
  const parsed = useMemo(() => parseTools(activeSet?.text ?? ""), [activeSet?.text]);
  const tools = parsed.tools ?? [];

  // Every call in the transcript, re-judged against the schema as it stands.
  const verdicts: CallVerdict[] = useMemo(
    () =>
      messages.flatMap((m) =>
        m.role === "assistant" ? (m.toolCalls ?? []).map((c) => validateCall(c, tools)) : [],
      ),
    [messages, tools],
  );
  const counts = tally(verdicts);

  function editText(text: string) {
    if (activeSet === null) return;
    const next = sets.map((s) => (s.id === activeSet.id ? { ...s, text } : s));
    setSets(next);
    saveToolSets(next);
  }

  async function run(history: PlayMessage[]) {
    if (model === null) return;
    // The assistant's own tool_calls ride back out alongside the tool result.
    // Without them the server receives a `role: "tool"` message answering a
    // call it never saw, and the turn reads as a non-sequitur to the model.
    const wire: ChatMessage[] = history.map((m) => {
      const out: ChatMessage = { role: m.role, content: m.content };
      if (m.toolCalls !== undefined && m.toolCalls.length > 0) out.toolCalls = m.toolCalls;
      if (m.toolName !== undefined) out.toolName = m.toolName;
      return out;
    });
    const controller = new AbortController();
    abortRef.current = controller;
    const replyId = newId();
    setSending(true);
    setError(null);
    setMessages([...history, { id: replyId, role: "assistant", content: "" }]);
    try {
      for await (const chunk of client.chat(model.tag, wire, {
        keepAlive,
        signal: controller.signal,
        // Omitted from the body entirely when empty — the client does that.
        tools,
      })) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === replyId
              ? {
                  ...m,
                  content: m.content + chunk.content,
                  toolCalls:
                    chunk.toolCalls === undefined
                      ? m.toolCalls
                      : [...(m.toolCalls ?? []), ...chunk.toolCalls],
                }
              : m,
          ),
        );
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSending(false);
    }
  }

  function send() {
    const text = draft.trim();
    if (text === "" || sending || model === null) return;
    setDraft("");
    void run([...messages, { id: newId(), role: "user", content: text }]);
  }

  /** Append a `role: "tool"` result for one call and continue the run. */
  function respond(call: ToolCall, key: string) {
    if (sending || model === null) return;
    // Same hazard as Send: continuing after the schema broke would send no
    // tools and misreport the result as the model ignoring them.
    if (parsed.error !== null || (parsed.tools?.length ?? 0) === 0) return;
    const content = responses[key] ?? "";
    setResponses((prev) => ({ ...prev, [key]: "" }));
    void run([
      ...messages,
      { id: newId(), role: "tool", content, toolName: call.name },
    ]);
  }

  function reset() {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
  }

  if (model === null) {
    // Reachable only by staying on the tab after the model went away — the
    // tab itself is gated (gate.ts). Say why rather than render an empty pane.
    return (
      <div className="toolwrap toolwrap-empty">
        <p className="tool-empty">Load a model that reports the <code>tools</code> capability.</p>
      </div>
    );
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") ?? null;

  return (
    <div className="toolwrap">
      <div className="toolside">
        <div className="toolside-h">
          <b>Tool schema</b>
          <span className="spacer" />
          <select
            className="toolset-pick"
            aria-label="Tool set"
            value={activeSet?.id ?? ""}
            onChange={(e) => setActiveSetId(e.target.value)}
          >
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <textarea
          className="jsonbox"
          aria-label="Tool schema"
          spellCheck={false}
          value={activeSet?.text ?? ""}
          onChange={(e) => editText(e.target.value)}
        />
        {parsed.error !== null && (
          <p className="jsonerr" role="status">
            Doesn&apos;t parse: {parsed.error}
          </p>
        )}
      </div>

      <div className="toolmain">
        <div className="tally">
          <span className="tally-label">this session</span>
          <b>{plural(counts.calls, "call", "calls")}</b>
          <span>·</span>
          <span className="ok">{counts.valid} valid</span>
          <span>·</span>
          <span className="bad">{counts.malformed} malformed</span>
          <span className="spacer" />
          <button type="button" className="btn sm ghost" onClick={reset}>
            Reset
          </button>
          <PaneHelpToggle paneId="tools" label="About the tool playground" />
        </div>

        <PaneHelp
          paneId="tools"
          title="Tools. See what the model actually calls"
          what="Every call the model makes here is checked against the schema you wrote for it. Argument by argument, not just whether the reply parsed."
          why="It turns “the model got the arguments wrong” from a guess into a badge on the exact key that was wrong, or missing."
          steps={[
            "Pick a tool set on the left, or write your own schema.",
            "Ask for something that needs one. The model’s call appears as a card.",
            "Read the badges: matched, valid arguments, anything missing.",
          ]}
          note="Nothing here is saved. This transcript is a scratch pad, not a chat."
        />

        <div className="toolscroll">
          {messages.length === 0 && (
            <div className="toolempty">
              <span className="ef-ic">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
                </svg>
              </span>
              <h3>See exactly what the model calls, and whether it got it right</h3>
              <p>
                A model that lists tools can call one instead of answering in prose. This is
                where you check the call it made against the schema you wrote. Argument by
                argument, not just whether the JSON parsed.
              </p>
              <ol className="ef-how">
                <li>
                  <b>1</b>
                  <span>Pick a tool set on the left, or write your own schema.</span>
                </li>
                <li>
                  <b>2</b>
                  <span>Ask for something that needs one. The model’s call appears as a card.</span>
                </li>
                <li>
                  <b>3</b>
                  <span>Read the badges: matched, valid arguments, anything missing.</span>
                </li>
              </ol>
            </div>
          )}
          {messages.map((m) => {
            if (m.role === "user") {
              return (
                <div className="umsg" key={m.id}>
                  <span className="bub">{m.content}</span>
                </div>
              );
            }
            if (m.role === "tool") {
              return (
                <div className="toolresult" key={m.id}>
                  <span className="pl">responded as {m.toolName}</span>
                  <code>{m.content}</code>
                </div>
              );
            }
            const calls = m.toolCalls ?? [];
            if (calls.length === 0) {
              if (m.content === "") {
                return sending ? (
                  <p className="tool-warming" key={m.id}>
                    warming up…
                  </p>
                ) : null;
              }
              // A model that lists `tools` can still answer in prose. That is
              // a finding, not an error — record it as one.
              return (
                <div className="plainreply" key={m.id}>
                  <span className="pl">answered without calling a tool</span>
                  <div className="plaintext">{m.content}</div>
                </div>
              );
            }
            return (
              <div key={m.id}>
                {calls.map((call, i) => (
                  <ToolCallCard
                    key={`${m.id}-${i}`}
                    call={call}
                    verdict={validateCall(call, tools)}
                    respondable={m === lastAssistant && !sending}
                    value={responses[`${m.id}-${i}`] ?? ""}
                    onValue={(v) => setResponses((prev) => ({ ...prev, [`${m.id}-${i}`]: v }))}
                    onRespond={() => respond(call, `${m.id}-${i}`)}
                  />
                ))}
                {m.content !== "" && <div className="plaintext">{m.content}</div>}
              </div>
            );
          })}
          {error !== null && (
            <p className="toolerr" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="toolcompose">
          <textarea
            aria-label="Tool prompt"
            placeholder="Ask something that should call a tool…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            type="button"
            className="btn primary"
            onClick={send}
            // A schema that doesn't parse — or an empty one — would be sent
            // as no tools at all, and the reply would then be reported under
            // "answered without calling a tool": a finding about the model,
            // when in fact nothing was offered to it.
            disabled={
              sending ||
              draft.trim() === "" ||
              parsed.error !== null ||
              (parsed.tools?.length ?? 0) === 0
            }
            title={
              parsed.error !== null
                ? "Fix the tool schema first"
                : (parsed.tools?.length ?? 0) === 0
                  ? "Define at least one tool first"
                  : undefined
            }
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolCallCard({
  call,
  verdict,
  respondable,
  value,
  onValue,
  onRespond,
}: {
  call: ToolCall;
  verdict: CallVerdict;
  respondable: boolean;
  value: string;
  onValue: (v: string) => void;
  onRespond: () => void;
}) {
  const invalid = verdict.args.filter((a) => a.verdict !== "ok").length;
  const keys = Object.keys(call.arguments);
  return (
    // Labelled as a group so the card is addressable as a whole — the
    // function name alone appears twice inside it (header and respond box).
    <div className="tcard" role="group" aria-label={`Tool call ${call.name}`}>
      <div className="tcard-h">
        <span className="fn">{call.name}</span>
        <span className={verdict.matched ? "vb ok" : "vb bad"}>
          {verdict.matched ? "matched" : "no such tool"}
        </span>
        <span className="spacer" />
        {invalid > 0 && <span className="vb bad">{invalid} invalid</span>}
        {verdict.missing.length > 0 && (
          <span className="vb miss">{verdict.missing.length} missing</span>
        )}
        {verdict.valid && <span className="vb ok">valid</span>}
      </div>
      <div className="args">
        {verdict.matched
          ? verdict.args.map((a) => (
              <div className={a.verdict === "ok" ? "argrow okrow" : "argrow badrow"} key={a.key}>
                <span className="ak">&quot;{a.key}&quot;</span>
                <span className="av">: {valueText(a.value)}</span>
                <span className="note">{a.detail}</span>
              </div>
            ))
          : // No schema matched, so no per-key verdict is honest: show the
            // arguments as the model sent them and let the header badge speak.
            keys.map((key) => (
              <div className="argrow" key={key}>
                <span className="ak">&quot;{key}&quot;</span>
                <span className="av">: {valueText(call.arguments[key])}</span>
              </div>
            ))}
        {verdict.missing.map((key) => (
          <div className="argrow missrow" key={`missing-${key}`}>
            <span className="ak">&quot;{key}&quot;</span>
            <span className="av">: </span>
            <span className="note">missing · required</span>
          </div>
        ))}
      </div>
      {respondable && (
        <div className="respond">
          <span className="rl">
            Respond as <code>{call.name}</code>
          </span>
          <input
            className="ri"
            aria-label={`Respond as ${call.name}`}
            placeholder='{"temp_c": 13}'
            value={value}
            onChange={(e) => onValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onRespond();
              }
            }}
          />
          <button
            type="button"
            className="btn sm"
            aria-label={`Send result as ${call.name}`}
            onClick={onRespond}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
