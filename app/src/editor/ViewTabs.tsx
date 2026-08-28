/**
 * Section tabs under the top nav (SPEC.md §5, docs/mockup.html `.tabs`):
 * Chat · Modelfile. The pull and settings views aren't tabs — they're
 * reached from the sidebar footer's "Get Models" button and gear
 * (Sidebar.tsx).
 */
import "./ViewTabs.css";
import { useRemuda } from "../ui/state";
import type { View } from "../ui/state";

export function ViewTabs() {
  const { view, setView, editorDraft, activeModel, openEditor } = useRemuda();

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
  // to the active resident model, same as "+ New chat" needs one loaded.
  function openModelfileTab() {
    if (editorDraft) {
      setView("modelfile");
      return;
    }
    if (activeModel) void openEditor(activeModel.variant);
  }

  return (
    <div className="tabs">
      {tab("chat", "Chat")}
      {tab("modelfile", "Modelfile", {
        disabled: !editorDraft && !activeModel,
        title: !editorDraft && !activeModel ? "Load a model first" : undefined,
        onClick: openModelfileTab,
      })}
    </div>
  );
}
