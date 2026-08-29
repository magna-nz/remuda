/**
 * The **Benches** group in the chats rail (docs/SPEC-tuning.md T5,
 * docs/SPEC-round-two.md R4; docs/mockup-proposals-2.html §01 `.side-label`).
 *
 * It sits above Recent because the rail persists across every surface
 * (SPEC §5) — which means a bench is reachable from inside the Modelfile
 * editor, which is exactly where the user is standing when they want to run
 * one.
 *
 * The header is shown even with nothing in it. A user who has never made a
 * bench has to encounter the word somewhere, and an empty group with one
 * line of explanation is cheaper to find than any tooltip.
 */
import "./BenchRail.css";
import { benchSubtitle } from "./benches";
import { useRemuda } from "../ui/state";
import { useTourTarget } from "../tour/registry";

export function BenchRail() {
  const { benches, activeBenchId, view, openBench, deleteBench, createBench, activeModel } =
    useRemuda();
  // R6 step 3's target. The header is here whether or not a bench is, which
  // is what makes the step safe on an app with nothing in it yet.
  const tourRef = useTourTarget("bench");

  return (
    <>
      <div className="side-label" ref={tourRef}>
        Benches
        <button
          type="button"
          className="side-add"
          title={activeModel ? "New bench" : "Load a model first"}
          aria-label="New bench"
          disabled={!activeModel}
          onClick={() => {
            const id = createBench();
            if (id !== null) openBench(id);
          }}
        >
          +
        </button>
      </div>
      <div className="benchlist">
        {benches.length === 0 ? (
          <p className="empty-note">
            A bench is a set of prompts you re-run after changing a Modelfile. Add one from any
            chat message.
          </p>
        ) : (
          benches.map((bench) => {
            const active = view === "bench" && bench.id === activeBenchId;
            return (
              <div key={bench.id} className={active ? "sess active" : "sess"}>
                <button
                  type="button"
                  className="sess-open"
                  aria-current={active || undefined}
                  title={bench.model}
                  onClick={() => openBench(bench.id)}
                >
                  <div className="strow">
                    <span className="stitle">{bench.name}</span>
                  </div>
                  <div className="smodel">{benchSubtitle(bench)}</div>
                </button>
                <button
                  type="button"
                  className="sess-x"
                  title={`Delete ${bench.name}`}
                  aria-label={`Delete bench ${bench.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteBench(bench.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
