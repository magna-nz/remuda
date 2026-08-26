/**
 * Settings view (SPEC.md §5.6). Server URL + Test connection are live; the
 * delete-confirmation toggle is real, persisted state (state.tsx) — it also
 * gates Save-over-existing (SPEC §8). The model/Modelfile directory rows are
 * still static placeholders (no filesystem access yet).
 */
import { useState } from "react";
import "./Settings.css";
import { useRemuda } from "./state";
import { createClient } from "../api/client";
import type { KeepAlive } from "../api/types";

type TestResult = "idle" | "testing" | "healthy" | "unreachable";

function parseKeepAlive(value: string): KeepAlive {
  if (value === "-1") return -1;
  return value as KeepAlive;
}

export function Settings() {
  const { status, models, keepAlive, setKeepAlive, confirmDeleteModel, setConfirmDeleteModel, serverUrl, setServerUrl } = useRemuda();
  const [draftUrl, setDraftUrl] = useState(serverUrl);
  const [testResult, setTestResult] = useState<TestResult>("idle");
  const urlChanged = draftUrl !== serverUrl;

  async function handleTest() {
    setTestResult("testing");
    try {
      const result = await createClient(draftUrl).version();
      setTestResult(result.connected ? "healthy" : "unreachable");
    } catch {
      setTestResult("unreachable");
    }
  }

  function handleApply() {
    setServerUrl(draftUrl);
    setTestResult("idle");
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
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            spellCheck={false}
            aria-label="Ollama server URL"
          />
          <button type="button" className="btn sm" onClick={() => void handleTest()}>
            Test
          </button>
          {urlChanged && (
            <button type="button" className="btn sm" onClick={handleApply}>
              Apply
            </button>
          )}
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
      </div>
    </section>
  );
}
