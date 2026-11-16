import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { HttpError } from "@/lib/errors";
import { log } from "@/lib/log";
import { text } from "@/lib/text";
import { Semaphore } from "@/lib/images/semaphore";

/**
 * Turns an uploaded photo into the three WebP variants this app stores, or refuses it.
 *
 * No routes and no database live here: `processImage()` takes bytes and a declared content type and returns
 * variants or throws. 14.4 owns the HTTP boundary (auth, body cap, rate limits, `x-client-op`) and 14.4 stores the
 * result; the controls in the spec's threat-model row for "malicious images" are all in this file.
 *
 * Four things are deliberate, because getting any of them wrong is the whole risk:
 *
 * 1. **The declared type is never trusted and neither is libvips' format support.** The bytes are sniffed here,
 *    before sharp sees them. libvips happily reads GIF, SVG, PDF, HEIC, TIFF and raw camera files; an SVG is a
 *    document that can pull in external references, and the rest are parsers we have no reason to expose. Only a
 *    JPEG, PNG or WebP whose magic bytes match the declared type gets past `sniff()`.
 * 2. **The pixel count is decided from the header, before anything is decoded.** `metadata()` parses the header
 *    only. A 20,000 x 20,000 PNG is 400 MP, or about 1.6 GB decoded; refusing it after the decode is not refusing
 *    it. `limitInputPixels` on the decode pipeline is the second line, not the first.
 * 3. **Variants are encoded from bare pixels, not from the input.** The input is decoded once to a raw RGB(A)
 *    buffer and every variant is encoded from that buffer. A raw buffer has no container and no metadata, so
 *    there is no EXIF, GPS, XMP or ICC profile left for an encoder to copy forward even by accident. That is a
 *    structural guarantee rather than a promise about sharp's defaults, and `process.test.ts` still reads the
 *    output bytes to check it.
 * 4. **One image at a time.** See `semaphore.ts`.
 *
 * Nothing here logs image bytes, and dimensions and byte counts are the only things that reach the log.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** The upload types the app accepts. iOS hands over a JPEG when the file input asks for these three. */
export const IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

/** Body cap, matching `readBodyCapped(request, MAX_INPUT_BYTES)` at the route. */
export const MAX_INPUT_BYTES = 4 * 1024 * 1024;

/**
 * 2048 x 2048: the size `client-resize.ts` produces. A client that skips the browser-side resize therefore cannot
 * make this replica decode a 24 MP photo; at this limit a decode is about 16 MB of RGBA.
 */
export const MAX_INPUT_PIXELS = 4_194_304;

/** Long edge and WebP quality per variant. `lg` goes on the listing page, `md` in lists, `sm` in the editor grid. */
export const VARIANTS = {
  lg: { edge: 1280, quality: 75 },
  md: { edge: 640, quality: 72 },
  sm: { edge: 320, quality: 70 },
} as const;
export type VariantName = keyof typeof VARIANTS;
export const VARIANT_NAMES = ["lg", "md", "sm"] as const;

/** An `lg` over this is re-encoded down the ladder; one that is still over is refused. */
export const LG_MAX_BYTES = 400 * 1024;
/** Tried in order after the first `lg` encode comes out too big. */
export const LG_QUALITY_LADDER = [65, 55] as const;

/** Whole-call budget: the wait for a slot plus the processing. The route's own budget is 10 s (spec). */
export const DEADLINE_MS = 10_000;

/**
 * One running, one waiting, everyone else told to come back.
 *
 * Note for review: the spec prose says "more than 2 waiting", which reads as `maxWaiting: 2`. Issue 14.2's
 * "Done when" is explicit the other way ("one running, one waiting is fine, the next is refused"), so that is
 * what this is. It is one constant if the looser reading wins later.
 */
export const MAX_CONCURRENT = 1;
export const MAX_WAITING = 1;

// libvips keeps a thread pool and an operation cache sized for a machine with memory to spare. On a 0.25 vCPU,
// 512 MiB replica both are a liability: extra threads each get a working copy of the image, and a cache that holds
// decoded images is exactly the allocation we are trying to avoid.
sharp.concurrency(1);
sharp.cache(false);

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

export const IMAGE_REJECTIONS = [
  "unsupported",
  "too_large_input",
  "too_many_pixels",
  "decode_failed",
  "too_large_after_encode",
  "busy",
  "timeout",
] as const;
export type ImageRejection = (typeof IMAGE_REJECTIONS)[number];

const REJECTION_STATUS: Record<ImageRejection, number> = {
  unsupported: 415,
  too_large_input: 413,
  too_many_pixels: 422,
  decode_failed: 422,
  too_large_after_encode: 422,
  busy: 429,
  timeout: 504,
};

const REJECTION_MESSAGE: Record<ImageRejection, string> = {
  unsupported: "That file isn't a JPEG, PNG or WebP photo.",
  too_large_input: "That photo is larger than 4 MB. Try again from the photo picker, which resizes before upload.",
  too_many_pixels: "That photo is larger than 2048 x 2048. Try again from the photo picker, which resizes before upload.",
  decode_failed: "That photo couldn't be read. It may have been cut short during upload.",
  too_large_after_encode: "That photo is too detailed to store at this size. Try a smaller crop.",
  busy: "Another photo is being processed. Try again in a few seconds.",
  timeout: "That photo took too long to process. Try a smaller one.",
};

/**
 * A refusal with a stable machine-readable `reason`. `errorInfo()` in `src/lib/http.ts` already maps any
 * `HttpError` to its status and message, so a route handler needs no special case and no stack trace reaches a
 * client. `retryAfterSeconds` is set for the refusals worth retrying.
 */
export class ImageError extends HttpError {
  readonly retryAfterSeconds?: number;

  constructor(
    readonly reason: ImageRejection,
    message: string = REJECTION_MESSAGE[reason],
  ) {
    super(REJECTION_STATUS[reason], message);
    if (reason === "busy") this.retryAfterSeconds = 3;
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Validated at this boundary and not only at the route, because this is the function that hands bytes to a C
 * library. `declaredType` is attacker-controlled free text (a request header), so it goes through `text()`:
 * trimmed, length-capped and NUL-free. An unexpected value is a rejection with a reason, not a zod error, so a
 * client that sends `image/gif` gets `unsupported` rather than "Invalid input".
 */
export const processImageInput = z.object({
  // `z.custom`, not `z.instanceof`: the latter infers `Uint8Array<ArrayBuffer>`, which a `Buffer` (always
  // `Uint8Array<ArrayBufferLike>`) is not assignable to, and every caller here hands over a Buffer.
  bytes: z.custom<Uint8Array>((v) => v instanceof Uint8Array, { message: "Image bytes are required" }),
  declaredType: text(100, { min: 1, minMessage: "A Content-Type is required" }),
  /** Tests use a short deadline; routes leave it alone. */
  deadlineMs: z.number().int().positive().max(60_000).default(DEADLINE_MS),
});
export type ProcessImageInput = z.input<typeof processImageInput>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type ProcessedVariant = {
  variant: VariantName;
  /** Always `image/webp`. */
  contentType: "image/webp";
  bytes: Buffer;
  width: number;
  height: number;
  /** The WebP quality this variant was finally encoded at. `lg` is below its nominal 75 when the ladder ran. */
  quality: number;
  /** Hex sha256 of `bytes`: the `photo_blob.sha256` column, the `ETag`, and the `?v=` in the URL. */
  sha256: string;
};

export type ProcessedImage = {
  variants: Record<VariantName, ProcessedVariant>;
  /** What came in, after orientation was applied. Never the input bytes themselves. */
  source: { format: ImageContentType; width: number; height: number; bytes: number; hadMetadata: boolean };
  totalBytes: number;
  ms: number;
};

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

type Sniffed = ImageContentType | "image/gif" | "image/svg+xml" | "unknown";

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/**
 * What the bytes actually are. Only the first three results are accepted; GIF and SVG are named so the log says
 * which kind of file was refused, and anything else is `unknown`.
 */
export function sniff(bytes: Uint8Array): Sniffed {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // SVG is text: skip a UTF-8 BOM and any leading whitespace, then look for the XML or SVG opening.
  let i = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  const head = Buffer.from(bytes.subarray(i, i + 512)).toString("latin1").toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!doctype svg")) return "image/svg+xml";
  return "unknown";
}

const isAccepted = (t: Sniffed): t is ImageContentType =>
  (IMAGE_CONTENT_TYPES as readonly string[]).includes(t);

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

const imageSemaphore = new Semaphore(MAX_CONCURRENT, MAX_WAITING, () => new ImageError("busy"));

/** For tests and for `/admin`: how many images are running and waiting right now. */
export const imageQueueStats = (): { active: number; waiting: number } => imageSemaphore.stats;

/**
 * Validates, refuses, or returns the three variants.
 *
 * Admission to the gate happens before the first `await`, so when several calls are made in the same tick they
 * are admitted in call order: with `MAX_CONCURRENT` 1 and `MAX_WAITING` 1, the third is refused `busy`.
 */
export function processImage(input: ProcessImageInput): Promise<ProcessedImage> {
  let parsed;
  try {
    parsed = processImageInput.parse(input);
  } catch (err) {
    return Promise.reject(err);
  }
  const { bytes, deadlineMs } = parsed;
  // `image/jpeg; charset=binary` is still a JPEG claim. Normalising the parameters away is not a loosening: the
  // value still has to be exactly one of the three types, and the bytes still have to agree with it.
  const declaredType = parsed.declaredType.split(";")[0].trim().toLowerCase();
  const startedAt = Date.now();

  // Cheap byte checks first: they cost nothing, so a junk upload never takes the slot a real photo is waiting for.
  if (bytes.byteLength === 0) return Promise.reject(reject("unsupported", startedAt, { declaredType, why: "empty" }));
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    return Promise.reject(reject("too_large_input", startedAt, { declaredType, bytes: bytes.byteLength }));
  }
  const sniffed = sniff(bytes);
  if (!isAccepted(sniffed) || sniffed !== declaredType) {
    return Promise.reject(reject("unsupported", startedAt, { declaredType, sniffed }));
  }

  // The slot is held until `work` settles even if the caller below stops waiting: libvips cannot be cancelled, so
  // handing the slot on while pixels are still in memory would put two decodes in flight.
  // A view, not a copy: at the 4 MB cap a copy would be 4 MB of peak RSS bought for nothing.
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const slotted = imageSemaphore.run(() => work(buf, sniffed, startedAt));
  return withDeadline(slotted, deadlineMs, () => reject("timeout", startedAt, { declaredType }));
}

async function work(bytes: Buffer, format: ImageContentType, startedAt: number): Promise<ProcessedImage> {
  // Header only: no pixel buffer is allocated and `toBuffer()` is never reached. `limitInputPixels: false` here is
  // what lets us answer `too_many_pixels` with the real dimensions instead of libvips' generic message, and the
  // decode below sets the real limit.
  let header;
  try {
    header = await sharp(bytes, { limitInputPixels: false, failOn: "error" }).metadata();
  } catch {
    throw reject("decode_failed", startedAt, { format, stage: "header" });
  }

  const { width, height, pages } = header;
  if (!width || !height) throw reject("decode_failed", startedAt, { format, stage: "header" });
  // libvips' own idea of the format has to agree with the magic bytes: a polyglot that starts with a JPEG marker
  // and is read as something else gets no further.
  if (header.format !== formatName(format)) {
    throw reject("unsupported", startedAt, { format, vipsFormat: header.format });
  }
  // Animated WebP: every frame would be decoded, so the pixel budget is per frame rather than per image.
  if (typeof pages === "number" && pages > 1) {
    throw reject("unsupported", startedAt, { format, pages, why: "animated" });
  }
  if (width * height > MAX_INPUT_PIXELS) {
    throw reject("too_many_pixels", startedAt, { format, width, height, pixels: width * height });
  }

  // Decode once, to bare pixels, with the limit set on the pipeline as well. `autoOrient()` applies the EXIF
  // orientation tag, so what lands in `pixels` is the photo the right way up; the tag itself goes no further.
  let pixels: Buffer;
  let info: { width: number; height: number; channels: number };
  try {
    const decoded = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", sequentialRead: true })
      .autoOrient()
      .raw()
      .toBuffer({ resolveWithObject: true });
    pixels = decoded.data;
    info = { width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels };
  } catch {
    throw reject("decode_failed", startedAt, { format, width, height });
  }

  const variants = {} as Record<VariantName, ProcessedVariant>;
  for (const name of VARIANT_NAMES) {
    variants[name] = await encodeVariant(name, pixels, info, startedAt);
  }

  const totalBytes = VARIANT_NAMES.reduce((n, v) => n + variants[v].bytes.byteLength, 0);
  const ms = Date.now() - startedAt;
  log.info("image.processed", {
    format,
    width: info.width,
    height: info.height,
    inputBytes: bytes.byteLength,
    totalBytes,
    lgQuality: variants.lg.quality,
    ms,
  });
  return {
    variants,
    source: {
      format,
      width: info.width,
      height: info.height,
      bytes: bytes.byteLength,
      hadMetadata: Boolean(header.exif ?? header.xmp ?? header.icc ?? header.iptc),
    },
    totalBytes,
    ms,
  };
}

/**
 * Encodes one variant from the decoded pixels. `withoutEnlargement` is what keeps a 320 x 240 photo at 320 x 240
 * in all three variants instead of blowing it up to 1280.
 *
 * `lg` carries the storage cap: over `LG_MAX_BYTES` it is re-encoded down `LG_QUALITY_LADDER`, and still over
 * means nothing is stored at all. `md` and `sm` are far below the cap at any realistic input and are not checked.
 */
async function encodeVariant(
  name: VariantName,
  pixels: Buffer,
  info: { width: number; height: number; channels: number },
  startedAt: number,
): Promise<ProcessedVariant> {
  const { edge, quality } = VARIANTS[name];
  const qualities = name === "lg" ? [quality, ...LG_QUALITY_LADDER] : [quality];

  let last: { bytes: Buffer; width: number; height: number; quality: number } | undefined;
  for (const q of qualities) {
    const out = await sharp(pixels, {
      raw: { width: info.width, height: info.height, channels: info.channels as 1 | 2 | 3 | 4 },
    })
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: q })
      .toBuffer({ resolveWithObject: true });
    last = { bytes: out.data, width: out.info.width, height: out.info.height, quality: q };
    if (name !== "lg" || out.data.byteLength <= LG_MAX_BYTES) break;
    log.info("image.reencode", { variant: name, quality: q, bytes: out.data.byteLength, limit: LG_MAX_BYTES });
  }

  /* c8 ignore next */
  if (!last) throw reject("decode_failed", startedAt, { variant: name });
  if (name === "lg" && last.bytes.byteLength > LG_MAX_BYTES) {
    throw reject("too_large_after_encode", startedAt, {
      variant: name,
      bytes: last.bytes.byteLength,
      limit: LG_MAX_BYTES,
      lowestQuality: last.quality,
    });
  }
  return {
    variant: name,
    contentType: "image/webp",
    bytes: last.bytes,
    width: last.width,
    height: last.height,
    quality: last.quality,
    sha256: createHash("sha256").update(last.bytes).digest("hex"),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatName = (t: ImageContentType) => ({ "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" })[t];

/** Builds the refusal and logs it in one place, so every rejection is logged exactly once and with no image data. */
function reject(reason: ImageRejection, startedAt: number, fields: Record<string, unknown> = {}): ImageError {
  log.warn("image.rejected", { reason, ms: Date.now() - startedAt, ...fields });
  return new ImageError(reason);
}

/**
 * Resolves with `promise`, or rejects with `onTimeout()` after `ms`. The underlying work is left running: it owns
 * the gate slot and releases it when it really finishes. Its eventual rejection is swallowed here so a timed-out
 * call cannot surface later as an unhandled rejection.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject_) => {
    const timer = setTimeout(() => reject_(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject_(err);
      },
    );
  });
}
