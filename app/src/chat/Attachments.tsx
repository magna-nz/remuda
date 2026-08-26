/**
 * Vision attachments (docs/mockup-proposals.html §05, left half).
 *
 * Ollama takes images on `messages[].images` as raw base64 — no `data:`
 * prefix — and the model list says which models accept them, so the paperclip
 * exists only for `vision`-capable models.
 *
 * Two arrays leave here for every attachment, and the split matters:
 *
 *   images      raw base64 of the original file. The wire format. In memory
 *               only — saveSessions() drops it.
 *   imageThumbs small `data:` URLs, downscaled to ~160px and JPEG-encoded.
 *               The ONLY image data that survives a reload, because
 *               localStorage caps around 5MB and one screenshot of base64
 *               would blow it.
 *
 * The consequence is visible in the UI: a restored session has thumbs and no
 * originals, so its thumbnails are marked as no longer available in full.
 */
import { useRef } from "react";
import "./Attachments.css";

/** Longest edge of a persisted thumbnail, in px. */
const THUMB_MAX_EDGE = 160;
/** JPEG quality for thumbnails — small enough to persist a handful of them. */
const THUMB_QUALITY = 0.7;
/**
 * If the browser can't decode/rescale the image, keep the original as the
 * thumb only when it is already small enough to persist; ~24KB of base64 is
 * a rounding error against the 5MB budget, a 4MB screenshot is not.
 */
const FALLBACK_THUMB_MAX_CHARS = 24_000;
/** A decode that never settles must not wedge the composer. */
const DECODE_TIMEOUT_MS = 4000;

export interface PendingImage {
  /** Local identity, for the removable thumbnail list. */
  id: string;
  name: string;
  /** Raw base64, no `data:` prefix — what Ollama's wire format wants. */
  base64: string;
  /** Downscaled `data:` URL; "" when the browser couldn't make one. */
  thumb: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.readAsDataURL(file);
  });
}

function decode(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = window.setTimeout(() => reject(new Error("decode timed out")), DECODE_TIMEOUT_MS);
    img.onload = () => {
      window.clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("could not decode image"));
    };
    img.src = dataUrl;
  });
}

/** Downscale to a persistable `data:` URL; "" when that isn't possible. */
export async function makeThumbnail(dataUrl: string): Promise<string> {
  try {
    const img = await decode(dataUrl);
    const longest = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
    if (longest === 0) throw new Error("zero-sized image");
    const scale = Math.min(1, THUMB_MAX_EDGE / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    canvas.height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", THUMB_QUALITY);
  } catch {
    return dataUrl.length <= FALLBACK_THUMB_MAX_CHARS ? dataUrl : "";
  }
}

/** `data:image/png;base64,AAA…` → `AAA…`; anything else passes through. */
export function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

let counter = 0;

export async function readImageFile(file: File): Promise<PendingImage | null> {
  try {
    const dataUrl = await readAsDataUrl(file);
    if (dataUrl === "") return null;
    counter += 1;
    return {
      id: `img-${Date.now().toString(36)}-${counter}`,
      name: file.name || "image",
      base64: stripDataUrlPrefix(dataUrl),
      thumb: await makeThumbnail(dataUrl),
    };
  } catch {
    return null;
  }
}

/** Read every image file, dropping the ones that fail. */
export async function readImageFiles(files: Iterable<File>): Promise<PendingImage[]> {
  const read = await Promise.all([...files].map((f) => readImageFile(f)));
  return read.filter((p): p is PendingImage => p !== null);
}

/** Image files out of a drop or paste, ignoring everything else on the clipboard. */
export function imageFilesFrom(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return [];
  const files: File[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && file.type.startsWith("image/")) files.push(file);
  }
  if (files.length === 0) {
    for (const file of Array.from(transfer.files ?? [])) {
      if (file.type.startsWith("image/")) files.push(file);
    }
  }
  return files;
}

function PictureIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

/** The composer paperclip. Rendered only for a vision-capable model. */
export function AttachButton({
  modelTag,
  disabled,
  onFiles,
}: {
  modelTag: string;
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="attach"
        title={`Attach an image — ${modelTag} supports vision`}
        aria-label="Attach an image"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
        </svg>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="attach-input"
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          // Reset so picking the same file twice fires onChange again.
          e.target.value = "";
        }}
      />
    </>
  );
}

/** Staged attachments above the composer, each removable before sending. */
export function PendingAttachments({
  items,
  onRemove,
}: {
  items: PendingImage[];
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="att pending" aria-label="Attached images">
      {items.map((item) => (
        <div className="thumb" key={item.id}>
          {item.thumb === "" ? <PictureIcon /> : <img src={item.thumb} alt={item.name} />}
          <button
            type="button"
            className="rm"
            aria-label={`Remove ${item.name}`}
            onClick={() => onRemove(item.id)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Thumbnails inside a sent user message.
 *
 * `full` is false for a session restored from localStorage: the thumb is all
 * that was persisted, so the tile says so rather than pretending the original
 * is a click away.
 */
export function MessageAttachments({ thumbs, full }: { thumbs: string[]; full: boolean }) {
  if (thumbs.length === 0) return null;
  return (
    <div className="att" aria-label="Attached images">
      {thumbs.map((thumb, i) => (
        <div className={`thumb${full ? "" : " gone"}`} key={i} title={full ? undefined : "Thumbnail only — the full image wasn’t saved with this chat"}>
          {thumb === "" ? <PictureIcon /> : <img src={thumb} alt={`Attachment ${i + 1}`} />}
          {!full && <span className="tag">thumbnail only</span>}
        </div>
      ))}
    </div>
  );
}
