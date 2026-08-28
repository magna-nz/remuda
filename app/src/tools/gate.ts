/**
 * The Tools tab's capability gate (docs/SPEC-tuning.md T3, SPEC.md §8).
 *
 * One-sided, and deliberately the opposite way round from the chat surface's
 * `canChat`. Chat degrades *open* on an empty capabilities list because the
 * cost of hiding it wrongly is a model the user cannot talk to at all. The
 * Tools tab is an **additive** control, so §8's rule applies: positive
 * evidence required. `[]` means "the server didn't say" — a server old enough
 * to omit capabilities is also one whose tool support we cannot vouch for,
 * and the cost of a false negative here is only a feature the user reaches
 * another way (the tab is absent; nothing is broken).
 */
import type { Model } from "../api/types";
import type { LoadedSelection } from "../ui/state";

/**
 * The model a Tools session would run against, or null when the tab must not
 * exist: nothing loaded, the loaded model isn't in the list, or its
 * capabilities do not *positively* list `tools`.
 *
 * The variant tag is what runs, so it is what's asked — falling back to the
 * base only when the variant isn't in the list (a Modelfile built this
 * session, say), because a variant inherits its base's capabilities.
 */
export function toolCapableModel(models: Model[], active: LoadedSelection | null): Model | null {
  if (active === null) return null;
  const model =
    models.find((m) => m.tag === active.variant) ?? models.find((m) => m.tag === active.base) ?? null;
  if (model === null) return null;
  return model.capabilities.includes("tools") ? model : null;
}
