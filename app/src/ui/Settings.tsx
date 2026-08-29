/**
 * Settings view (SPEC.md §5.6). Server URL + Test connection are live; the
 * delete-confirmation toggle is real, persisted state (state.tsx) — it also
 * gates Save-over-existing (SPEC §8). The model/Modelfile directory rows are
 * still static placeholders (no filesystem access yet).
 *
 * The Documentation section (T8) opens the published docs site in the system
 * browser via `openExternal`, never a bare `<a href>` — an anchor would
 * navigate the webview itself and trap the user with no way back. Outside
 * the desktop shell (a plain browser tab, or a test run) `openExternal`
 * rejects rather than resolving silently (`/desktop app/` in the message),
 * so every click handler here catches and surfaces the failure inline
 * instead of doing nothing.
 */
import { Fragment, useState } from "react";
import "./Settings.css";
import { useRemuda } from "./state";
import { createClient } from "../api/client";
import { DEFAULT_BASE_URL, type KeepAlive } from "../api/types";
import { openExternal } from "../api/host";
import { GLOSSARY } from "../help/glossary";
import { reopenAll } from "../help/persistence";

type TestResult = "idle" | "testing" | "healthy" | "unreachable";

function parseKeepAlive(value: string): KeepAlive {
  if (value === "-1") return -1;
  return value as KeepAlive;
}

/** Base URL of the published documentation site (T8). One place, not scattered through the JSX. */
export const DOCS_BASE_URL = "https://magna-nz.github.io/remuda/";

const REPO_URL = "https://github.com/magna-nz/remuda";

interface DocLink {
  label: string;
  href: string;
}

/** A few deep links that earn their place, plus the repository — not one undifferentiated "Docs" link. */
const DOC_LINKS: DocLink[] = [
  { label: "Getting started", href: `${DOCS_BASE_URL}getting-started.html` },
  { label: "The Modelfile editor", href: `${DOCS_BASE_URL}modelfile-editor.html` },
  { label: "Troubleshooting", href: `${DOCS_BASE_URL}troubleshooting.html` },
  { label: "Repository", href: REPO_URL },
];

export function Settings() {
  const { status, models, keepAlive, setKeepAlive, confirmDeleteModel, setConfirmDeleteModel } = useRemuda();
  const [serverUrl, setServerUrl] = useState(DEFAULT_BASE_URL);
  const [testResult, setTestResult] = useState<TestResult>("idle");
  const [docsError, setDocsError] = useState<string | null>(null);

  async function handleTest() {
    setTestResult("testing");
    try {
      const result = await createClient(serverUrl).version();
      setTestResult(result.connected ? "healthy" : "unreachable");
    } catch {
      setTestResult("unreachable");
    }
  }

  function handleOpenDoc(url: string) {
    setDocsError(null);
    openExternal(url).catch((err: unknown) => {
      setDocsError(err instanceof Error ? err.message : String(err));
    });
  }

  const diskUsedGb = models.reduce((sum, m) => sum + m.sizeBytes, 0) / 1_000_000_000;

  return (
    <section className="settings" aria-label="Settings">
      <div className="eyebrow">Settings</div>
      <div className="setgrid">
        <div className="setrow">
          <div className="st">
            <b>Ollama server</b>
            <div>Where Remuda sends its API calls. Local only by default.</div>
          </div>
          <input
            className="input"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            spellCheck={false}
            aria-label="Ollama server URL"
          />
          <button type="button" className="btn sm" onClick={() => void handleTest()}>
            Test
          </button>
          {testResult !== "idle" && (
            <span className={`test-result ${testResult}`} role="status">
              {testResult === "testing" ? "Testing…" : testResult === "healthy" ? "Healthy" : "Unreachable"}
            </span>
          )}
        </div>
        <div className="setrow">
          <div className="st">
            <b>Connection</b>
            <div>
              {status.connected
                ? `${status.version ? `Server v${status.version}` : "Connected"} · ${models.length} model${models.length === 1 ? "" : "s"} · ${diskUsedGb.toFixed(1)} GB on disk`
                : "Not connected"}
            </div>
          </div>
          <span className={`conn-readout${status.connected ? "" : " off"}`}>
            <span className="dot" aria-hidden="true" />
            {status.connected ? "Healthy" : "Unreachable"}
          </span>
        </div>
        <div className="setrow">
          <div className="st">
            <b>Keep models loaded</b>
            <div>
              How long a model stays in memory after its last request (<code>keep_alive</code>).
            </div>
          </div>
          <select
            className="input"
            aria-label="Keep models loaded"
            value={String(keepAlive)}
            onChange={(e) => setKeepAlive(parseKeepAlive(e.target.value))}
          >
            <option value="5m">5 minutes</option>
            <option value="30m">30 minutes</option>
            <option value="-1">Forever</option>
          </select>
        </div>
        <div className="setrow">
          <div className="st">
            <b>Models directory</b>
            <div className="mono-line">~/.ollama/models · read-only</div>
          </div>
          <button type="button" className="btn sm" disabled title="coming later">
            Reveal
          </button>
        </div>
        <div className="setrow">
          <div className="st">
            <b>Modelfile directory</b>
            <div>
              Where <b>Save as new</b> writes tuned Modelfiles. <span className="mono-line">~/ollama/modelfiles</span>
            </div>
          </div>
          <button type="button" className="btn sm" disabled title="coming in M3">
            Choose…
          </button>
        </div>
        <div className="setrow">
          <div className="st">
            <b>Confirm before deleting a model</b>
            <div>Ask for confirmation on destructive actions.</div>
          </div>
          <button
            type="button"
            className={`toggle${confirmDeleteModel ? " on" : ""}`}
            role="switch"
            aria-checked={confirmDeleteModel}
            aria-label="Confirm before deleting a model"
            onClick={() => setConfirmDeleteModel(!confirmDeleteModel)}
          />
        </div>
        <div className="setrow docs-row">
          <div className="st">
            <b>Documentation</b>
            <div>Opens in your browser, not this window.</div>
          </div>
          <div className="docs-links">
            {DOC_LINKS.map((link) => (
              <button
                key={link.href}
                type="button"
                className="btn sm"
                onClick={() => handleOpenDoc(link.href)}
              >
                {link.label}
              </button>
            ))}
          </div>
        </div>
        {docsError !== null && (
          <div className="setrow docs-error" role="alert">
            <div className="st">{docsError}</div>
          </div>
        )}
      </div>

      <div className="eyebrow help-eyebrow">Help</div>
      <div className="setgrid">
        <div className="setrow">
          <div className="st">
            <b>Guided tour</b>
            <div>
              A five-step walk through the model control, the Modelfile editor, Bench, Format
              and Prompt.
            </div>
          </div>
          <button
            type="button"
            className="btn sm"
            disabled
            title="Arrives with the guided tour — not built yet"
          >
            Run the tour
          </button>
        </div>
        <div className="setrow">
          <div className="st">
            <b>Pane explainers</b>
            <div>
              The <code>?</code> panel at the top of each pane. Closing one keeps it closed —
              this brings them all back.
            </div>
          </div>
          <button type="button" className="btn sm" onClick={() => reopenAll()}>
            Reopen all
          </button>
        </div>
        <div className="setrow glossary-row">
          <div className="st">
            <b>Glossary</b>
            <div>Every machine word Remuda uses, and what it means here.</div>
            <dl className="glossary-list">
              {Object.values(GLOSSARY).map((entry) => (
                <Fragment key={entry.term}>
                  <dt>{entry.term}</dt>
                  <dd>{entry.definition}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}
