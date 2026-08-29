/**
 * The "stop & reload" toast (SPEC.md §5.4, docs/mockup.html `.reloadtoast`):
 * bottom-center, showing `ollama create`'s streamed status, then "Stopping
 * <old>…", then "Reloading <new> with new Modelfile…", then "✓ <new>
 * reloaded" before auto-dismissing. Mounted at the app shell level (like
 * LoadPane) so it survives the save flow's switch back to the Chat view.
 */
import "./ReloadToast.css";
import { useRemuda } from "../ui/state";

function textFor(
  toast: NonNullable<ReturnType<typeof useRemuda>["reloadToast"]>,
): string {
  switch (toast.phase) {
    case "creating":
      return toast.detail ? `Creating ${toast.newTag}: ${toast.detail}…` : `Creating ${toast.newTag}…`;
    case "stopping":
      return `Stopping ${toast.oldTag ?? "the running model"}…`;
    case "reloading":
      return `Reloading ${toast.newTag} with new Modelfile…`;
    case "done":
      return `✓ ${toast.newTag} reloaded`;
  }
}

export function ReloadToast() {
  const { reloadToast } = useRemuda();
  if (!reloadToast) return null;

  return (
    <div className="reloadtoast" role="status">
      <span className="rspin" aria-hidden="true" />
      <div className="rt-txt">{textFor(reloadToast)}</div>
    </div>
  );
}
