/**
 * Modelfile snapshot history — the store (SPEC-tuning.md T1).
 *
 * Every successful Save / Save as… drops the Modelfile's `rawText` into a
 * per-tag ring buffer. Modelfiles run 1–2 KB, so 40 deep per model is ~80 KB
 * — an order of magnitude under the budget that forced image thumbs in
 * SPEC §6. Snapshots are content-addressed: saving without changing the text
 * adds nothing.
 *
 * Persistence follows chat/sessions.ts exactly — a versioned key, pure
 * load/save, per-field coercion, and a try/catch that degrades to an empty
 * list rather than crashing. Quota failures are swallowed: history simply
 * won't survive a restart, which must never break saving a model.
 */

/**
 * Do not bump this. Every field added after v1 must be optional, so a v1
 * payload parses unchanged; a new key would orphan — i.e. delete — every
 * existing user's history for no gain.
 */
export const HISTORY_STORAGE_KEY = "remuda.modelfile-history.v1";

/** Snapshots kept per model tag (SPEC-tuning T1). */
export const TAG_RING_CAP = 40;

/**
 * Total snapshots kept across all tags. The per-tag cap alone is unbounded
 * in the number of tags, so there is a global lid too — but it never takes
 * a tag's *last* snapshot, so a model always retains at least the state it
 * was first seen in.
 */
export const TOTAL_CAP = 400;

export interface ModelfileSnapshot {
  id: string;
  tag: string;
  rawText: string;
  savedAt: string; // ISO 8601
  kind: "save" | "saveas" | "restore";
  /** The snapshot this text was edited from; null when there wasn't one. */
  parentId?: string | null;
}

/**
 * FNV-1a, 32-bit, hex. Content addressing only — this is a change detector,
 * not a security primitive, and it must not cost a dependency.
 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // hash * 16777619 in 32-bit arithmetic, without overflowing a double.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function newSnapshotId(now: Date = new Date()): string {
  return `mf-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Most-recent first. Stable for equal timestamps (insertion order wins). */
export function sortSnapshots(snapshots: ModelfileSnapshot[]): ModelfileSnapshot[] {
  return [...snapshots].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** One tag's ring, newest first. */
export function snapshotsForTag(all: ModelfileSnapshot[], tag: string | null): ModelfileSnapshot[] {
  if (tag === null) return [];
  return all.filter((s) => s.tag === tag);
}

/**
 * Trim to the caps: oldest-first within a tag, then oldest-first globally —
 * except that a tag holding a single snapshot is never emptied.
 */
function evict(all: ModelfileSnapshot[]): ModelfileSnapshot[] {
  const perTag = new Map<string, number>();
  const kept: ModelfileSnapshot[] = [];
  // `all` is newest-first, so counting forwards keeps the newest 40 per tag.
  for (const snapshot of all) {
    const seen = perTag.get(snapshot.tag) ?? 0;
    if (seen >= TAG_RING_CAP) continue;
    perTag.set(snapshot.tag, seen + 1);
    kept.push(snapshot);
  }
  if (kept.length <= TOTAL_CAP) return kept;

  // Global lid. Walk oldest-first and drop until we're under, skipping any
  // snapshot that is the only one left for its tag.
  const remaining = new Map(perTag);
  const doomed = new Set<ModelfileSnapshot>();
  for (let i = kept.length - 1; i >= 0 && kept.length - doomed.size > TOTAL_CAP; i--) {
    const snapshot = kept[i]!;
    const count = remaining.get(snapshot.tag) ?? 0;
    if (count <= 1) continue; // never evict a tag's last remaining snapshot
    remaining.set(snapshot.tag, count - 1);
    doomed.add(snapshot);
  }
  return kept.filter((s) => !doomed.has(s));
}

/**
 * Content-addressed append (SPEC-tuning T1). Returns `all` unchanged — the
 * same array reference — when the tag's newest snapshot already holds this
 * text, so a save that changed nothing records nothing.
 */
export function appendSnapshot(
  all: ModelfileSnapshot[],
  snapshot: ModelfileSnapshot,
): ModelfileSnapshot[] {
  const head = all.find((s) => s.tag === snapshot.tag);
  // Compared exactly, not by hash: a 32-bit FNV collision would silently
  // drop a real edit, and the string compare is cheaper anyway. `hashText`
  // stays for the drift check, where the working text is compared against
  // every snapshot rather than just the head.
  if (head !== undefined && head.rawText === snapshot.rawText) {
    return all;
  }
  return evict([snapshot, ...all]);
}

/**
 * Reading persisted data is a two-tier job, and the tiers must not be
 * confused (the same rule as chat/sessions.ts).
 *
 * The *required* spine — id/tag/rawText/savedAt — is what makes a snapshot a
 * snapshot; if any of it is wrong the record is unreadable and gets dropped,
 * alone, without taking the rest of the ring with it.
 *
 * Everything else is optional. An unrecognised `kind` falls back to "save"
 * and a malformed `parentId` is dropped, because throwing away a user's only
 * copy of a Modelfile over a sidecar field would be a data-loss bug wearing
 * a validator's clothes.
 */
function coerceKind(value: unknown): ModelfileSnapshot["kind"] {
  return value === "save" || value === "saveas" || value === "restore" ? value : "save";
}

function coerceSnapshot(value: unknown): ModelfileSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const s = value as Record<string, unknown>;
  if (
    typeof s.id !== "string" ||
    typeof s.tag !== "string" ||
    typeof s.rawText !== "string" ||
    typeof s.savedAt !== "string"
  ) {
    return null;
  }
  const snapshot: ModelfileSnapshot = {
    id: s.id,
    tag: s.tag,
    rawText: s.rawText,
    savedAt: s.savedAt,
    kind: coerceKind(s.kind),
  };
  if (typeof s.parentId === "string") {
    snapshot.parentId = s.parentId;
  }
  return snapshot;
}

/** Load persisted snapshots; corrupt or missing data starts empty. */
export function loadHistory(): ModelfileSnapshot[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const snapshots: ModelfileSnapshot[] = [];
    for (const entry of parsed) {
      const snapshot = coerceSnapshot(entry);
      if (snapshot !== null) snapshots.push(snapshot);
    }
    return evict(sortSnapshots(snapshots));
  } catch {
    return [];
  }
}

export function saveHistory(snapshots: ModelfileSnapshot[]): void {
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(snapshots));
  } catch {
    // Quota/private-mode failures: history simply won't survive a restart.
    // It must never take the save it was recording down with it.
  }
}

/** Human label for a snapshot's kind, as the timeline shows it. */
export function kindLabel(kind: ModelfileSnapshot["kind"]): string {
  if (kind === "saveas") return "Save as…";
  if (kind === "restore") return "Restore";
  return "Save";
}
