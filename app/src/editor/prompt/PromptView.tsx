/**
 * The rendered prompt — the editor's fourth pane (SPEC-round-two.md R3,
 * docs/mockup-proposals-2.html §03).
 *
 * Left: the model's `TEMPLATE`, slots marked. Right: that template executed
 * against the current chat, substituted values marked. The left footer
 * carries the check the pane exists for — **references `.System`** — which
 * goes red when the template cannot see the system prompt the Modelfile is
 * setting, a bug that is invisible from the chat window.
 *
 * Two deliberate choices, both about honesty:
 *
 *  - **The template comes from the draft, not from `/api/show`.** R3 says the
 *    template is already carried on `ModelDetail.template`; the store keeps
 *    only the parsed Modelfile, and `TEMPLATE` is one of its instructions
 *    (`modelfile/parse.ts`). Reading it from the draft costs no request and
 *    is strictly better: an edit to `TEMPLATE` in the Raw pane is reflected
 *    here immediately, so the pane describes the Modelfile being edited
 *    rather than the one last built.
 *  - **A template outside the renderer's subset is not rendered at all.**
 *    The right column falls back to the raw template and names the action
 *    that stopped it. A wrong render is worse than an absent one.
 */
import { useState } from "react";
import "./PromptView.css";
import { useRemuda } from "../../ui/state";
import {
  serializeModelfile,
  system as systemOf,
  template as templateOf,
} from "../../modelfile";
import { copyText } from "../../chat/ReplyMenu";
import { PaneHelp, PaneHelpToggle } from "../../help/PaneHelp";
import { analyseTemplate, declaredRenderer } from "./analyse";
import {
  renderTemplate,
  scanTemplate,
  type ActionToken,
  type RenderSegment,
  type TemplateMessage,
} from "./render";
import type { ChatSession } from "../../chat/sessions";

/** UTF-8 bytes — what actually crosses the wire, not UTF-16 code units. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Which chat the template is rendered against.
 *
 * The open chat first, because that is the one the user is reasoning about.
 * Failing that, the newest chat that ran on the model being edited — opening
 * a Modelfile from the sidebar's pencil leaves no active session, and
 * rendering against an unrelated conversation would be worse than useless.
 * Newest overall is the last resort; null means "no chats yet", which the
 * pane says rather than papering over.
 */
export function chatForRender(
  sessions: ChatSession[],
  activeSessionId: string | null,
  targetTag: string | null,
): ChatSession | null {
  const active = sessions.find((s) => s.id === activeSessionId);
  if (active !== undefined) return active;
  if (targetTag !== null) {
    const forTag = sessions.find((s) => s.model === targetTag);
    if (forTag !== undefined) return forTag;
  }
  return sessions[0] ?? null;
}

/**
 * The transcript as the template sees it.
 *
 * `thinking` is already absent from stored messages and tool calls have no
 * place in `.Content`, so this is a straight projection: role and content,
 * in order, exactly what `ui/state.tsx`'s `forWire` sends.
 */
function messagesFor(session: ChatSession | null): TemplateMessage[] {
  if (session === null) return [];
  return session.messages.map((m) => ({ role: m.role, content: m.content }));
}

/** `.Prompt` is the completion-era field: the last thing the user asked. */
function lastUserPrompt(session: ChatSession | null): string {
  if (session === null) return "";
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i].role === "user") return session.messages[i].content;
  }
  return "";
}

/**
 * One action, with its field reference boxed as a slot.
 *
 * The verbatim source is re-emitted byte for byte — the slot is a `<span>`
 * placed around the `.Field` substring, never a re-serialization of what we
 * parsed. The left column must show the template the user wrote.
 */
function ActionSource({ token }: { token: ActionToken }) {
  const action = token.action;
  if (action.kind === "unsupported") {
    return <span className="act unsupported">{token.source}</span>;
  }
  if (action.kind === "end") {
    return <span className="act">{token.source}</span>;
  }
  const needle = `.${action.field}`;
  const at = token.source.indexOf(needle);
  if (at === -1) return <span className="act">{token.source}</span>;
  return (
    <span className="act">
      {token.source.slice(0, at)}
      <span className="slot">{needle}</span>
      {token.source.slice(at + needle.length)}
    </span>
  );
}

function TemplateSource({ template }: { template: string }) {
  const tokens = scanTemplate(template);
  return (
    <div className="code" aria-label="Template">
      {tokens.map((token, i) =>
        token.kind === "text" ? (
          <span key={i}>{token.text}</span>
        ) : (
          <ActionSource key={i} token={token} />
        ),
      )}
    </div>
  );
}

function RenderedSource({ segments }: { segments: RenderSegment[] }) {
  return (
    <div className="code" aria-label="Rendered prompt">
      {segments.map((segment, i) =>
        segment.kind === "literal" ? (
          <span key={i}>{segment.text}</span>
        ) : (
          <span key={i} className="slotfill" title={`.${segment.field}`}>
            {segment.text}
          </span>
        ),
      )}
    </div>
  );
}

export function PromptView() {
  const { editorDraft, sessions, activeSessionId } = useRemuda();
  const [copied, setCopied] = useState(false);

  if (editorDraft === null) return null;

  const doc = editorDraft.doc;
  const template = templateOf(doc) ?? "";
  // A declared RENDERER means Ollama builds the prompt natively and the
  // TEMPLATE is a stub, so neither the render nor the .System check speaks
  // for what the model receives. See `declaredRenderer`.
  const renderer = declaredRenderer(serializeModelfile(doc));
  const analysis = analyseTemplate(template);
  const session = chatForRender(sessions, activeSessionId, editorDraft.targetTag);
  const messages = messagesFor(session);

  const result = renderTemplate(template, {
    system: systemOf(doc) ?? "",
    prompt: lastUserPrompt(session),
    messages,
    // Remuda has no per-chat tool list to hand a template yet (T3's tools
    // live in their own view), so `.Tools` renders as unset — which is what
    // a chat without tools actually sends.
    tools: "",
  });

  async function copy() {
    if (!result.ok) return;
    const ok = await copyText(result.text);
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (analysis.empty) {
    return (
      <div className="promptview empty">
        <p>
          This Modelfile has no <code>TEMPLATE</code>, so there is nothing to render. Ollama
          falls back to the base model's own template — open the base model's Modelfile to
          see it.
        </p>
      </div>
    );
  }

  return (
    <div className="promptview">
      <div className="prompt-h">
        <span className="hint">
          rendering:{" "}
          {session === null ? (
            <b>no chats yet — only the system prompt is substituted</b>
          ) : (
            <>
              <b>{session.title}</b> · {messages.length}{" "}
              {messages.length === 1 ? "message" : "messages"}
            </>
          )}
        </span>
        <span className="spacer" />
        <PaneHelpToggle paneId="prompt" />
      </div>

      <PaneHelp
        paneId="prompt"
        title="Prompt — the exact text the model receives"
        what="Your SYSTEM and your messages don’t reach the model as you wrote them — Ollama pours them into the model’s own template, which adds the control tokens that family expects."
        why="This pane shows the result, so a system prompt that never reaches the model is obvious here instead of invisible from the chat window."
        steps={[
          "Left is the template Ollama reports; the highlighted words are its slots.",
          "Right is the same template with your current chat filled in.",
          <>
            Watch the <b>references .System</b> check — if it goes red, your system prompt is
            being dropped before the model ever sees it.
          </>,
        ]}
      />

      <div className="split prompt-split">
        <div className="col">
          <div className="col-h">
            <span className="eyebrow">Template</span>
            <span className="hint">from the Modelfile · read-only</span>
          </div>
          <TemplateSource template={template} />
          <div className="prompt-foot">
            {/* The indicator is a Go-template question. A Jinja template
                addresses the system prompt through its `messages` array and
                never writes `.System`, so a red flag here would be a false
                alarm on every model that ships one — which is most modern
                ones. Absent, not red: a figure that can't be read honestly
                is not rendered at all. */}
            {renderer !== null ? (
              <span className="hint">
                <code>RENDERER {renderer}</code> builds the prompt —{" "}
                <code>.System</code> does not apply
              </span>
            ) : analysis.dialect === "jinja" ? (
              <span className="hint">
                Jinja template — <code>.System</code> does not apply
              </span>
            ) : analysis.referencesSystem ? (
              <span className="ok">
                ✓ references <code>.System</code>
              </span>
            ) : (
              <span className="bad" role="status">
                ✕ does not reference <code>.System</code> — your system prompt never reaches
                the model
              </span>
            )}
            <span className="spacer" />
            <code>
              {analysis.slots} {analysis.slots === 1 ? "slot" : "slots"}
            </code>
          </div>
        </div>
        <div className="col">
          <div className="col-h">
            <span className="eyebrow">Rendered</span>
            <span className="hint">
              {result.ok ? `${byteLength(result.text).toLocaleString()} bytes` : "not rendered"}
            </span>
          </div>
          {/* A declared RENDERER supersedes the template, so even a template
              that renders cleanly is not the prompt. The banner sits above
              the output rather than in the failure branch, because the
              misleading case is precisely the one that succeeds:
              gemma4 ships `TEMPLATE {{ .Prompt }}`, which renders perfectly
              and is a fraction of what the model is sent. */}
          {renderer !== null && result.ok && (
            <div className="render-refused" role="status">
              <code>RENDERER {renderer}</code> assembles this model's prompt inside Ollama.
              What follows is only the <code>TEMPLATE</code> executed — not what the model
              receives.
            </div>
          )}
          {result.ok ? (
            <RenderedSource segments={result.segments} />
          ) : (
            <>
              {/* Two different refusals, and conflating them misleads. A
                  Jinja template isn't an unsupported *action* — it is a
                  different language, and saying "unsupported action" would
                  send someone hunting for a construct to remove. */}
              <div className="render-refused" role="status">
                {renderer !== null ? (
                  <>
                    This model declares <code>RENDERER {renderer}</code>, so Ollama assembles
                    the prompt with a built-in renderer and the <code>TEMPLATE</code> above is
                    only a fragment of it. What is rendered here is not what the model
                    receives.
                  </>
                ) : analysis.dialect === "jinja" ? (
                  <>
                    This model ships a <b>Jinja</b> chat template, the format newer models
                    embed in their weights. Remuda renders Go{" "}
                    <code>text/template</code> only, so the template is shown as-is. Nothing
                    is wrong with the model or the Modelfile.
                  </>
                ) : (
                  <>
                    {result.message} Remuda renders a documented subset of Go{" "}
                    <code>text/template</code> — <code>if</code>, <code>range</code>,{" "}
                    <code>.System</code>, <code>.Prompt</code>, <code>.Messages</code>,{" "}
                    <code>.Role</code>, <code>.Content</code>, <code>.Tools</code> — and shows
                    the raw template rather than guessing at the rest.
                  </>
                )}
              </div>
              <TemplateSource template={template} />
            </>
          )}
          <div className="prompt-foot">
            <button
              type="button"
              className="btn sm"
              onClick={() => void copy()}
              disabled={!result.ok}
              title={result.ok ? undefined : "Nothing rendered to copy"}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            {/* TODO (R3, deferred): "Send as raw…" — post this text through
                /api/generate with `raw: true`, which bypasses templating, so
                a raw send and a normal send agreeing proves the render right.
                It needs a `generate()` on the API client and a store action,
                both outside this pane's ownership. */}
            <span className="spacer" />
            <span className="legend">green = substituted</span>
          </div>
        </div>
      </div>
    </div>
  );
}
