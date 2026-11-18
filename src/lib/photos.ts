import "server-only";
import { type SQL, and, asc, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan, isPublic, ownsListing, publicListing, uuidOr404 } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { ConflictError, HttpError, NotFoundError, PayloadTooLargeError, ServiceBusyError, UnsupportedMediaTypeError } from "@/lib/errors";
import { LIMITS } from "@/lib/listing-schema";
import { lockAgent, type PhotoMeta } from "@/lib/listings";
import { log } from "@/lib/log";
import { matchesMagic } from "@/lib/magic";
import { text } from "@/lib/text";
import { type Tx, advisoryLock, consumeRate, releaseRate } from "@/lib/usage";

/**
 * Photo data layer: the upload boundary, storage, and the one function that reads photo bytes.
 *
 * Every function takes the acting user and calls `assertCan()` first (`getPhotoVariant` is the exception that proves
 * the rule: it serves anonymous visitors, so it decides visibility itself, below). A listing id that isn't the
 * agent's own is a 404, the same answer as a missing one.
 *
 * What an upload goes through, in order, cheapest refusal first so junk never takes the single image slot:
 *   1. ownership (404), declared type and magic bytes (415), size (413)
 *   2. one short transaction: replay of the same `x-client-op` (returns the first photo), the 12-photo cap (409), the
 *      app-wide store cap (409), and the per-agent `photo_upload` allowance
 *   3. `processImage()` (src/lib/images/process.ts): outside any transaction, because it is slow
 *   4. one short transaction that re-checks 2 under the locks and writes the photo and its three blobs
 * The allowance is handed back when nothing was attempted (the gate was full), the cap turned out to be hit while the
 * photo was processing, or the request was a replay; it is kept when the work ran, whatever it said.
 */

/** Body cap. Must equal `MAX_INPUT_BYTES` in the image module (a test pins that). */
export const PHOTO_MAX_BYTES = 4 * 1024 * 1024;
/** What the upload accepts. Must equal `IMAGE_CONTENT_TYPES` in the image module (a test pins that). */
export const PHOTO_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoUploadType = (typeof PHOTO_UPLOAD_TYPES)[number];
export const PHOTO_UPLOADS_PER_HOUR = 60;
const TOO_MANY_UPLOADS = "Too many photo uploads this hour. Try again later.";

const L = schema.listing;
const P = schema.listingPhoto;
const B = schema.photoBlob;

/**
 * How many uploads may be in flight at once on this replica, from the moment the body starts to be read until the
 * response is decided. Every one of them can hold a 4 MB body (about 5 MB measured, with the copy `Buffer.concat`
 * makes), and none of the other limits can see that memory: the hourly allowance is spent after the read, and the
 * image gate (one running, one waiting) sits behind a database transaction. Without this, one signed-in agent opening
 * many slow connections walks around the memory budget the image gate exists to defend.
 *
 * 4 = the gate's one running and one waiting, plus two still reading their bodies or waiting on the database. That
 * implies roughly 4 x 5 MB = 20 MB of request buffers on top of the image work, against the replica's 512 MB. Measured
 * (see the 14.4 PR): 40 concurrent 4 MB uploads took the server from 216 MB to 406 MB before this existed.
 *
 * App-wide, in memory, so it is per replica (the replica count is 1). Over the bound is `503` `busy` with
 * `Retry-After`: nothing was read or attempted, and retrying is the right advice.
 */
export const MAX_UPLOADS_IN_FLIGHT = 4;
let uploadsInFlight = 0;

/**
 * Take an in-flight upload slot **before reading the body**, and call the returned release in a `finally` that
 * covers the read and `uploadPhoto()`, so a throw mid-read can't leak the slot. Releasing twice is harmless.
 */
export function admitUpload(): () => void {
  if (uploadsInFlight >= MAX_UPLOADS_IN_FLIGHT) {
    log.warn("photo.upload_refused", { why: "in_flight", inFlight: uploadsInFlight });
    throw new ServiceBusyError("Other photos are being uploaded right now. Try again in a few seconds.");
  }
  uploadsInFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    uploadsInFlight -= 1;
  };
}

/** For tests: how many uploads hold a slot right now. */
export const uploadsInFlightNow = () => uploadsInFlight;

/** The `Content-Type` header, minus parameters, as one of the accepted types; anything else is a 415. */
export function declaredPhotoType(header: string | null | undefined): PhotoUploadType {
  const value = typeof header === "string" ? header.split(";")[0].trim().toLowerCase() : "";
  if (!(PHOTO_UPLOAD_TYPES as readonly string[]).includes(value)) {
    throw new UnsupportedMediaTypeError("Send the photo as image/jpeg, image/png or image/webp.");
  }
  return value as PhotoUploadType;
}

/** Ids that aren't the agent's: 404. Cheap, so the route can run it before it reads a 4 MB body. */
export async function assertOwnsListing(actor: Actor | null, rawListingId: string): Promise<string> {
  assertCan(actor, "listing:manage");
  const id = uuidOr404(rawListingId);
  const [row] = await db().select({ id: L.id }).from(L).where(and(eq(L.id, id), eq(L.agentId, actor.id)));
  if (!row) throw new NotFoundError();
  return id;
}

const uploadInput = z.object({
  bytes: z.custom<Uint8Array>((v) => v instanceof Uint8Array, { message: "Photo bytes are required" }),
  contentType: text(200, { min: 1, minMessage: "A Content-Type is required" }),
  /** One id per user intent (src/lib/client-op.ts); a retry with the same id returns the first photo. */
  clientOpId: z.string().uuid(),
});

const storeCapBytes = () => env().PHOTO_STORE_CAP_MB * 1024 * 1024;

async function storedBytes(tx: Tx | ReturnType<typeof db>): Promise<number> {
  const [{ total }] = await tx.select({ total: sql<string>`coalesce(sum(${P.bytesTotal}), 0)` }).from(P);
  return Number(total);
}

async function metaFor(executor: Tx | ReturnType<typeof db>, photoId: string): Promise<PhotoMeta> {
  const [r] = await executor
    .select({ id: P.id, position: P.position, alt: P.alt, width: P.width, height: P.height, sha256: P.sha256 })
    .from(P)
    .where(eq(P.id, photoId));
  const { sha256, ...rest } = r;
  return { ...rest, v: sha256.slice(0, 8) };
}

/** The listing row, locked for the rest of the transaction, or 404. Every photo write takes it before touching photos. */
async function lockOwnListing(tx: Tx, actor: Actor, listingId: string): Promise<{ id: string; status: string }> {
  const [row] = await tx
    .select({ id: L.id, status: L.status })
    .from(L)
    .where(and(eq(L.id, listingId), eq(L.agentId, actor.id)))
    .for("update");
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * Upload one photo to the agent's own listing. Idempotent per (listing, `clientOpId`): a retry, or two parallel
 * retries, return the first photo with `created: false` and cost nothing.
 */
export async function uploadPhoto(
  actor: Actor | null,
  rawListingId: string,
  input: { bytes: Uint8Array; contentType: string | null; clientOpId: string },
): Promise<{ photo: PhotoMeta; created: boolean }> {
  assertCan(actor, "listing:manage");
  const listingId = await assertOwnsListing(actor, rawListingId);
  const data = uploadInput.parse({ ...input, contentType: input.contentType ?? "" });

  const type = declaredPhotoType(data.contentType);
  if (data.bytes.byteLength > PHOTO_MAX_BYTES) throw new PayloadTooLargeError(PHOTO_MAX_BYTES);
  // The declared type is the caller's word; the bytes have to agree with it. `processImage()` checks again.
  if (!matchesMagic(type, data.bytes)) throw new UnsupportedMediaTypeError("That file isn't the type it says it is.");

  // Reserve: replay, caps, allowance. Nothing is written but the allowance row.
  const reserved = await db().transaction(async (tx) => {
    await lockAgent(tx, actor);
    await lockOwnListing(tx, actor, listingId);
    const [existing] = await tx.select({ id: P.id }).from(P).where(and(eq(P.listingId, listingId), eq(P.clientOpId, data.clientOpId)));
    if (existing) return { replay: existing.id };
    await assertRoom(tx, listingId, 0);
    await consumeRate(tx, actor.id, "photo_upload", PHOTO_UPLOADS_PER_HOUR, TOO_MANY_UPLOADS);
    return { replay: null };
  });
  if (reserved.replay) return { photo: await metaFor(db(), reserved.replay), created: false };

  let processed;
  try {
    // Loaded here, not at the top: this module is also what `/img` imports, and serving a photo has no business
    // loading sharp.
    const { processImage } = await import("@/lib/images/process");
    processed = await processImage({ bytes: data.bytes, declaredType: type });
  } catch (err) {
    // `busy` and `queue_timeout` mean nothing was attempted, so the allowance is handed back. Anything that ran
    // (decode_failed, too_large_after_encode, timeout) keeps it: a refund there would let a client drive the image
    // gate for free. An unexpected error is ours, not theirs, so it is refunded too.
    const reason = err instanceof HttpError ? (err as HttpError & { reason?: string }).reason : undefined;
    if (!(err instanceof HttpError) || reason === "busy" || reason === "queue_timeout") await refund(actor);
    throw err;
  }

  try {
    return await db().transaction(async (tx) => {
      await lockAgent(tx, actor);
      await lockOwnListing(tx, actor, listingId);
      // A parallel retry of the same intent may have finished while this one was processing.
      const [existing] = await tx.select({ id: P.id }).from(P).where(and(eq(P.listingId, listingId), eq(P.clientOpId, data.clientOpId)));
      if (existing) {
        await releaseRate(tx, actor.id, "photo_upload");
        return { photo: await metaFor(tx, existing.id), created: false };
      }
      // One writer at a time for the app-wide cap, so two uploads can't both fit into the last megabyte.
      await advisoryLock(tx, "photo-store");
      await assertRoom(tx, listingId, processed.totalBytes);

      const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${P.position}) + 1, 0)::int` }).from(P).where(eq(P.listingId, listingId));
      const lg = processed.variants.lg;
      const [row] = await tx
        .insert(P)
        .values({
          listingId,
          position: next,
          width: lg.width,
          height: lg.height,
          bytesTotal: processed.totalBytes,
          sha256: lg.sha256,
          clientOpId: data.clientOpId,
        })
        .returning({ id: P.id });
      await tx.insert(B).values(
        (["lg", "md", "sm"] as const).map((variant) => {
          const v = processed.variants[variant];
          return { photoId: row.id, variant, bytes: v.bytes, sha256: v.sha256, width: v.width, height: v.height };
        }),
      );
      log.info("photo.stored", { listingId, photoId: row.id, bytes: processed.totalBytes, position: next });
      return { photo: await metaFor(tx, row.id), created: true };
    });
  } catch (err) {
    // The photo wasn't stored for a reason that isn't the client's work being bad: give the allowance back.
    if (!(err instanceof HttpError) || err instanceof ConflictError) await refund(actor);
    throw err;
  }
}

/** 409 when the listing already has 12 photos, or when adding `extraBytes` would pass the app-wide store cap. */
async function assertRoom(tx: Tx, listingId: string, extraBytes: number): Promise<void> {
  const [{ n }] = await tx.select({ n: count() }).from(P).where(eq(P.listingId, listingId));
  if (n >= LIMITS.photosPerListing) throw new ConflictError(`A listing can have at most ${LIMITS.photosPerListing} photos. Delete one first.`);
  // `max(extra, 1)`: a store already exactly at the cap has no room either, even before the new size is known.
  if ((await storedBytes(tx)) + Math.max(extraBytes, 1) > storeCapBytes()) {
    throw new ConflictError("This site has reached its photo storage limit, so no more photos can be added right now.");
  }
}

async function refund(actor: Actor): Promise<void> {
  try {
    await db().transaction((tx) => releaseRate(tx, actor.id, "photo_upload"));
  } catch (err) {
    log.warn("photo.refund_failed", { error: err instanceof Error ? err.name : "unknown" });
  }
}

const updatePhotoInput = z
  .object({
    alt: text(150).optional(),
    /** The new place in the order, 0 = cover. Above the last photo means last. */
    position: z.number().int().min(0).max(LIMITS.photosPerListing - 1).optional(),
  })
  .refine((v) => v.alt !== undefined || v.position !== undefined, "Nothing to change");

const TOO_MANY_WRITES = "Too many changes this hour. Try again later.";

/** Alt text and/or position of one photo. Reordering renumbers 0..n-1, so the cover is always `position = 0`. */
export async function updatePhoto(actor: Actor | null, rawListingId: string, rawPhotoId: string, input: unknown): Promise<PhotoMeta[]> {
  assertCan(actor, "listing:manage");
  const data = updatePhotoInput.parse(input);
  const listingId = uuidOr404(rawListingId);
  const photoId = uuidOr404(rawPhotoId);
  await db().transaction(async (tx) => {
    await lockAgent(tx, actor);
    await lockOwnListing(tx, actor, listingId);
    await consumeRate(tx, actor.id, "api_write", LIMITS.writesPerHour, TOO_MANY_WRITES);
    const photos = await tx.select({ id: P.id, position: P.position }).from(P).where(eq(P.listingId, listingId)).orderBy(asc(P.position));
    if (!photos.some((p) => p.id === photoId)) throw new NotFoundError();
    if (data.alt !== undefined) await tx.update(P).set({ alt: data.alt }).where(and(eq(P.id, photoId), eq(P.listingId, listingId)));
    if (data.position !== undefined) {
      const order = photos.map((p) => p.id).filter((id) => id !== photoId);
      order.splice(Math.min(data.position, order.length), 0, photoId);
      // (listing_id, position) is DEFERRABLE INITIALLY DEFERRED, so the intermediate states of these updates don't collide.
      for (const [i, id] of order.entries()) await tx.update(P).set({ position: i }).where(and(eq(P.id, id), eq(P.listingId, listingId)));
    }
  });
  return listPhotos(actor, listingId);
}

/** Delete one photo. Its blobs go with it (foreign key cascade), and the photos after it close the gap. */
export async function deletePhoto(actor: Actor | null, rawListingId: string, rawPhotoId: string): Promise<void> {
  assertCan(actor, "listing:manage");
  const listingId = uuidOr404(rawListingId);
  const photoId = uuidOr404(rawPhotoId);
  await db().transaction(async (tx) => {
    await lockAgent(tx, actor);
    const listing = await lockOwnListing(tx, actor, listingId);
    await consumeRate(tx, actor.id, "api_write", LIMITS.writesPerHour, TOO_MANY_WRITES);
    const photos = await tx.select({ id: P.id }).from(P).where(eq(P.listingId, listingId)).orderBy(asc(P.position));
    if (!photos.some((p) => p.id === photoId)) throw new NotFoundError();
    if ((listing.status === "active" || listing.status === "pending") && photos.length === 1) {
      throw new ConflictError("A public listing needs at least one photo. Add another one first, or withdraw the listing.");
    }
    await tx.delete(P).where(and(eq(P.id, photoId), eq(P.listingId, listingId)));
    const rest = photos.filter((p) => p.id !== photoId);
    for (const [i, p] of rest.entries()) await tx.update(P).set({ position: i }).where(eq(P.id, p.id));
  });
}

/** The agent's photos on one of their listings, in order (metadata only, never bytes). */
export async function listPhotos(actor: Actor | null, rawListingId: string): Promise<PhotoMeta[]> {
  const listingId = await assertOwnsListing(actor, rawListingId);
  const rows = await db()
    .select({ id: P.id, position: P.position, alt: P.alt, width: P.width, height: P.height, sha256: P.sha256 })
    .from(P)
    .where(eq(P.listingId, listingId))
    .orderBy(asc(P.position));
  return rows.map(({ sha256, ...r }) => ({ ...r, v: sha256.slice(0, 8) }));
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

export type ServedPhoto =
  /** The caller's `If-None-Match` matched. No bytes were read to answer. Only ever for a public photo. */
  | { kind: "not_modified"; etag: string }
  /** `public`: active and not hidden, cacheable forever. Otherwise the owner's own draft or hidden photo. */
  | { kind: "ok"; etag: string; bytes: Buffer; visibility: "public" | "owner" };

const VARIANT_SET = new Set<string>(schema.PHOTO_VARIANTS);

/** The quoted strong ETag for a stored sha256. */
export const etagFor = (sha256: string) => `"${sha256}"`;

/** Does an `If-None-Match` header name this ETag? Weak validators and `*` count, as RFC 9110 says for GET. */
export function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const v = part.trim();
    return v === "*" || v.replace(/^W\//, "") === etag;
  });
}

/**
 * One photo variant, or 404. **The access decision is made before anything else and by one query that never selects
 * `bytes`**: the variant's hash and its listing's status, hidden flag and owner. That one answer covers both
 * outcomes that follow it:
 *
 * - **public** (active and not hidden): a matching `If-None-Match` is answered 304 from that query alone, so a
 *   revalidation costs one indexed lookup and never reads the photo. Otherwise the bytes are read, with the public
 *   condition repeated in the `where`, so a listing hidden between the two queries is a 404 and not a stale 200.
 * - **not public** (draft, withdrawn, sold, hidden): only the owning agent, and never a 304, because the response is
 *   `no-store`. Anyone else gets the same 404 as a missing id. The 304 path cannot be reached by someone who could
 *   not have the 200: the check comes first for both.
 *
 * The actor is resolved lazily (`resolveActor`), and only when the photo isn't public: a listing page loads up to 36
 * variants, nearly all of them for anonymous or signed-in visitors looking at public photos, and none of those need a
 * session lookup.
 *
 * The content type is never stored or taken from anyone: the bytes are checked to be WebP before they are returned
 * (`matchesMagic`, a positive allowlist), so a blob that somehow held an SVG or HTML is refused here rather than
 * served as something a browser would execute. Nothing the upload route writes can be that; this is what holds if
 * a row is ever written some other way.
 */
export async function getPhotoVariant(
  resolveActor: () => Promise<Actor | null>,
  rawPhotoId: string,
  rawVariant: string,
  ifNoneMatch: string | null,
): Promise<ServedPhoto> {
  const photoId = uuidOr404(rawPhotoId);
  if (!VARIANT_SET.has(rawVariant)) throw new NotFoundError();
  const variant = rawVariant as (typeof schema.PHOTO_VARIANTS)[number];

  const [meta] = await db()
    .select({ sha256: B.sha256, status: L.status, hiddenAt: L.hiddenAt, agentId: L.agentId })
    .from(B)
    .innerJoin(P, eq(P.id, B.photoId))
    .innerJoin(L, eq(L.id, P.listingId))
    .where(and(eq(B.photoId, photoId), eq(B.variant, variant)));
  if (!meta) throw new NotFoundError();
  const etag = etagFor(meta.sha256);

  let visibility: "public" | "owner";
  let access: SQL;
  if (isPublic(meta)) {
    visibility = "public";
    access = publicListing();
    if (matchesIfNoneMatch(ifNoneMatch, etag)) return { kind: "not_modified", etag };
  } else {
    const actor = await resolveActor();
    if (!ownsListing(actor, meta)) throw new NotFoundError();
    visibility = "owner";
    access = eq(L.agentId, actor!.id);
  }

  const [row] = await db()
    .select({ bytes: B.bytes })
    .from(B)
    .innerJoin(P, eq(P.id, B.photoId))
    .innerJoin(L, eq(L.id, P.listingId))
    .where(and(eq(B.photoId, photoId), eq(B.variant, variant), access));
  if (!row) throw new NotFoundError();
  if (!matchesMagic("image/webp", row.bytes)) {
    log.error("photo.serve_refused", { photoId, variant, why: "not_webp" });
    throw new NotFoundError();
  }
  return { kind: "ok", etag, bytes: row.bytes, visibility };
}
