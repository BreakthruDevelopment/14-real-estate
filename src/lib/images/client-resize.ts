/**
 * Browser-side resize, run before a photo is uploaded.
 *
 * This is a **courtesy, not a control**. It keeps a 12 MP phone photo from becoming a 6 MB upload that the
 * 0.25 vCPU replica then has to decode, which is the difference between a usable editor and a timeout on hotel
 * wifi. The server trusts none of its output: `processImage()` re-sniffs the bytes, re-checks the pixel count and
 * re-encodes from scratch, and a client that skips this file entirely gets the same answers.
 *
 * No `server-only` import and no Node APIs here: this runs in the browser.
 */

/** What the file input accepts. Safari and iOS hand over a JPEG instead of HEIC when asked for these three. */
export const ACCEPTED_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const FILE_INPUT_ACCEPT = ACCEPTED_UPLOAD_TYPES.join(",");

/** Long edge after the browser-side resize. The same number as the server's `MAX_INPUT_PIXELS` side. */
export const CLIENT_MAX_EDGE = 2048;
/** Canvas encode quality. 0.85 WebP of a phone photo is around 0.5 MB at 2048 px. */
export const CLIENT_QUALITY = 0.85;
/** The server's body cap. A file still over this after the resize is refused here rather than wasting the upload. */
export const CLIENT_MAX_BYTES = 4 * 1024 * 1024;

export type ResizedUpload = {
  blob: Blob;
  type: "image/webp" | "image/jpeg";
  width: number;
  height: number;
  /** False when the picture was already within `CLIENT_MAX_EDGE` and came through at its original size. */
  resized: boolean;
};

/**
 * The size an image becomes when it has to fit inside `max` on its long edge.
 *
 * Never enlarges: an image already within `max` is returned untouched, which is the client-side half of the
 * server's `withoutEnlargement`. Rounds to whole pixels and never returns 0, because a canvas of width 0 throws.
 */
export function fitWithin(width: number, height: number, max: number = CLIENT_MAX_EDGE): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("fitWithin needs positive, finite dimensions");
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= max) return { width: Math.round(width), height: Math.round(height) };
  const scale = max / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** True when the browser has everything `resizeForUpload` needs. On anything else the caller uploads the file as it is. */
export function canResizeInBrowser(): boolean {
  return typeof createImageBitmap === "function" && typeof document !== "undefined";
}

/**
 * Decodes, orients, resizes and re-encodes a picked file.
 *
 * `imageOrientation: "from-image"` is what makes a photo taken sideways come out upright: the decoded bitmap has
 * the EXIF orientation already applied, and the canvas it is drawn onto carries no metadata forward, so the
 * upload leaves the phone without its GPS tags. That is a nice-to-have, not the control — the server strips
 * metadata again on the way in, because a direct POST never runs this code.
 */
export async function resizeForUpload(file: File | Blob, maxEdge: number = CLIENT_MAX_EDGE): Promise<ResizedUpload> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const target = fitWithin(bitmap.width, bitmap.height, maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't prepare the photo for upload.");
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);

    // WebP first; Safari before 14 and a few Android browsers fall back to JPEG. `toBlob` hands back a PNG when
    // it does not know the type, so the result type is checked rather than assumed.
    const webp = await toBlob(canvas, "image/webp", CLIENT_QUALITY);
    const blob = webp?.type === "image/webp" ? webp : await toBlob(canvas, "image/jpeg", CLIENT_QUALITY);
    if (!blob || (blob.type !== "image/webp" && blob.type !== "image/jpeg")) {
      throw new Error("This browser can't prepare the photo for upload.");
    }
    if (blob.size > CLIENT_MAX_BYTES) {
      throw new Error("That photo is too large to upload even after resizing. Try a smaller crop.");
    }
    return {
      blob,
      type: blob.type,
      width: target.width,
      height: target.height,
      resized: target.width !== bitmap.width || target.height !== bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
