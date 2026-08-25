/**
 * Settings view (SPEC.md §5.6). Server URL + Test connection are live;
 * the model/Modelfile directory rows and delete-confirmation toggle are
 * static placeholders for M1 (no filesystem access or persistence yet).
 */
import { useState } from "react";
import "./Settings.css";
import { useRemuda } from "./state";
import { DEFAULT_BASE_URL, type KeepAlive } from "../api/types";

type TestResult = "idle" | "testing" | "healthy" | "unreachable";

function parseKeepAlive(value: string): KeepAlive {
  if (value === "-1") return -1;
  return value as KeepAlive;
}

export function Settings() {
  const { client, status, models, keepAlive, setKeepAlive } = useRemuda();
  const [serverUrl, setServerUrl] = useState(DEFAULT_BASE_URL);
  const [testResult, setTestResult] = useState<TestResult>("idle");
  const [confirmDelete, setConfirmDelete] = useState(true);

  async function handleTest() {
    setTestResult("testing");
    try {
      const result = await client.version();
      setTestResult(result.connected ? "healthy" : "unreachable");
    } catch {
      setTestResult("unreachable");
    }
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
                ? `Server v${status.version} · ${models.length} model${models.length === 1 ? "" : "s"} · ${diskUsedGb.toFixed(1)} GB on disk`
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
            className={`toggle${confirmDelete ? " on" : ""}`}
            role="switch"
            aria-checked={confirmDelete}
            aria-label="Confirm before deleting a model"
            onClick={() => setConfirmDelete((v) => !v)}
          />
        </div>
      </div>
    </section>
  );
}
