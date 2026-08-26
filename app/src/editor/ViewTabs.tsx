/**
 * Section tabs under the top nav (SPEC.md §5, docs/mockup.html `.tabs`):
 * Chat · Modelfile on the left, Pull · Settings on the right. Pull is also
 * reachable from the sidebar's "Pull models" footer button (Sidebar.tsx).
 */
import "./ViewTabs.css";
import { useRemuda } from "../ui/state";
import type { View } from "../ui/state";

export function ViewTabs() {
  const { view, setView, editorDraft, loaded, openEditor } = useRemuda();

  const tab = (target: View, label: string, opts?: { disabled?: boolean; title?: string; onClick?: () => void }) => (
    <button
      type="button"
      className={`tab${view === target ? " active" : ""}`}
      aria-current={view === target || undefined}
      disabled={opts?.disabled}
      title={opts?.title}
      onClick={opts?.onClick ?? (() => setView(target))}
    >
      {label}
    </button>
  );

  // The tab strip is a *switcher*, not an entry point — opening the editor
  // for a specific model happens via the pencil in TopNav or the load
  // pane's "+ New Modelfile" (SPEC §5.1, §5.4). If there's already a draft
  // (from either of those), the tab just shows it; otherwise it falls back
  // to the currently loaded model, same as "+ New chat" needs one loaded.
  function openModelfileTab() {
    if (editorDraft) {
      setView("modelfile");
      return;
    }
    if (loaded) void openEditor(loaded.variant);
  }

  return (
    <div className="tabs">
      {tab("chat", "Chat")}
      {tab("modelfile", "Modelfile", {
        disabled: !editorDraft && !loaded,
        title: !editorDraft && !loaded ? "Load a model first" : undefined,
        onClick: openModelfileTab,
      })}
      <div className="spacer" />
      {tab("pull", "Pull")}
      {tab("settings", "Settings")}
    </div>
  );
}
