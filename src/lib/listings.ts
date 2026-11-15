import "server-only";
import { type SQL, and, asc, count, desc, eq, sql } from "drizzle-orm";
import { assertCan, isPublic, ownsListing, uuidOr404 } from "@/lib/access";
import { ForbiddenError, type Actor, toRole } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError, UnprocessableError } from "@/lib/errors";
import { haversineMiles } from "@/lib/geo/distance";
import {
  FAR_MILES,
  LIMITS,
  type ListingStatus,
  STATUS_TRANSITIONS,
  locationInput,
  newListingInput,
  updateListingInput,
} from "@/lib/listing-schema";
import { log } from "@/lib/log";
import { type Tx, advisoryLock, consumeRate } from "@/lib/usage";

/**
 * Listing data layer. Every function takes the acting user and calls `assertCan()` (src/lib/access.ts) first.
 *
 * Which columns leave this module is decided here and nowhere else: `embedding`, `tsv`, `search_text` and
 * `embed_hash` are never selected. Public shapes also leave out `agent_notes`, `agent_id` and the hidden fields.
 */

const L = schema.listing;

/** Columns every viewer may see (a listing that is active and not hidden). */
const publicColumns = {
  id: L.id,
  title: L.title,
  propertyType: L.propertyType,
  status: L.status,
  priceUsd: L.priceUsd,
  beds: L.beds,
  baths: L.baths,
  sqft: L.sqft,
  lotSqft: L.lotSqft,
  yearBuilt: L.yearBuilt,
  features: L.features,
  addressLine: L.addressLine,
  city: L.city,
  state: L.state,
  zip: L.zip,
  lat: L.lat,
  lng: L.lng,
  geoSource: L.geoSource,
  description: L.description,
  publishedAt: L.publishedAt,
  updatedAt: L.updatedAt,
};

const PUBLIC_KEYS = Object.keys(publicColumns) as (keyof typeof publicColumns)[];

/** Copy only the public columns, so nothing added to `ownerColumns` later can leak into a public response. */
function toPublic<T extends Record<keyof typeof publicColumns, unknown>>(row: T): Pick<T, keyof typeof publicColumns> {
  return Object.fromEntries(PUBLIC_KEYS.map((k) => [k, row[k]])) as Pick<T, keyof typeof publicColumns>;
}

/** What the owning agent sees on top: notes, hidden state, version for optimistic locking. */
const ownerColumns = {
  ...publicColumns,
  agentNotes: L.agentNotes,
  hiddenAt: L.hiddenAt,
  hiddenReason: L.hiddenReason,
  version: L.version,
  createdAt: L.createdAt,
};

export type PhotoMeta = { id: string; position: number; alt: string; width: number; height: number; v: string };
const selectOwner = (where: SQL | undefined) => db().select(ownerColumns).from(L).where(where);
export type OwnerListing = Awaited<ReturnType<typeof selectOwner>>[number] & { photos: PhotoMeta[] };

/** Photo metadata only (never bytes). `v` is the 8-character cache-busting token for `/img/[id]/[variant]?v=`. */
async function photosFor(listingId: string): Promise<PhotoMeta[]> {
  const rows = await db()
    .select({
      id: schema.listingPhoto.id,
      position: schema.listingPhoto.position,
      alt: schema.listingPhoto.alt,
      width: schema.listingPhoto.width,
      height: schema.listingPhoto.height,
      sha256: schema.listingPhoto.sha256,
    })
    .from(schema.listingPhoto)
    .where(eq(schema.listingPhoto.listingId, listingId))
    .orderBy(asc(schema.listingPhoto.position));
  return rows.map(({ sha256, ...r }) => ({ ...r, v: sha256.slice(0, 8) }));
}


/**
 * GET /api/listings/[id], the public page and the agent's preview. The owning agent gets the full row in any
 * status; everyone else (signed out, buyer, other agent, admin) gets it only while it is active and not hidden.
 * Everything else, a missing id included, is a 404.
 */
export async function getListing(actor: Actor | null, rawId: string) {
  const id = uuidOr404(rawId);
  const [row] = await db()
    .select({ ...ownerColumns, agentId: L.agentId })
    .from(L)
    .where(eq(L.id, id));
  if (!row) throw new NotFoundError();
  if (ownsListing(actor, row)) {
    return { listing: { ...toPublic(row), agentNotes: row.agentNotes, hiddenAt: row.hiddenAt, hiddenReason: row.hiddenReason, version: row.version, createdAt: row.createdAt }, viewer: "owner" as const, photos: await photosFor(id) };
  }
  if (!isPublic(row)) throw new NotFoundError();
  return { listing: toPublic(row), viewer: "public" as const, photos: await photosFor(id) };
}

/** A listing the actor owns, or 404. Used by every agent read and write. */
export async function getMyListing(actor: Actor | null, rawId: string): Promise<OwnerListing> {
  assertCan(actor, "listing:manage");
  const id = uuidOr404(rawId);
  const [row] = await selectOwner(and(eq(L.id, id), eq(L.agentId, actor.id)));
  if (!row) throw new NotFoundError();
  return { ...row, photos: await photosFor(id) };
}

/** The agent's own listings with counts for the dashboard. At most 50 (the per-agent cap). */
export async function listMyListings(actor: Actor | null, opts: { status?: ListingStatus } = {}) {
  assertCan(actor, "listing:manage");
  const where: (SQL | undefined)[] = [eq(L.agentId, actor.id)];
  if (opts.status) where.push(eq(L.status, opts.status));
  return db()
    .select({
      id: L.id,
      title: L.title,
      status: L.status,
      propertyType: L.propertyType,
      priceUsd: L.priceUsd,
      beds: L.beds,
      baths: L.baths,
      city: L.city,
      state: L.state,
      zip: L.zip,
      hiddenAt: L.hiddenAt,
      hiddenReason: L.hiddenReason,
      version: L.version,
      updatedAt: L.updatedAt,
      photoCount: sql<number>`(select count(*)::int from listing_photo p where p.listing_id = ${L.id})`,
      coverPhotoId: sql<string | null>`(select p.id from listing_photo p where p.listing_id = ${L.id} order by p.position limit 1)`,
      inquiryCount: sql<number>`(select count(*)::int from inquiry i where i.listing_id = ${L.id})`,
      openInquiryCount: sql<number>`(select count(*)::int from inquiry i where i.listing_id = ${L.id} and i.status = 'open')`,
    })
    .from(L)
    .where(and(...where))
    .orderBy(desc(L.updatedAt))
    .limit(LIMITS.listingsPerAgent);
}

/**
 * Lock the acting user's row for the rest of the transaction and check they are still an unbanned agent. The role
 * in `actor` came from the session; this re-reads it, so a revoke that committed a moment ago wins, and a revoke
 * (which takes the same row FOR UPDATE) waits for a write that is already in flight.
 */
export async function lockAgent(tx: Tx, actor: Actor): Promise<void> {
  const [u] = await tx
    .select({ role: schema.user.role, banned: schema.user.banned })
    .from(schema.user)
    .where(eq(schema.user.id, actor.id))
    .for("share");
  if (!u || u.banned || toRole(u.role) !== "agent") throw new ForbiddenError();
}

const TOO_MANY_WRITES = "Too many changes this hour. Try again later.";

async function centroidFor(tx: Tx | ReturnType<typeof db>, zip: string): Promise<{ lat: number; lng: number } | null> {
  const [c] = await tx.select({ lat: schema.zipCentroid.lat, lng: schema.zipCentroid.lng }).from(schema.zipCentroid).where(eq(schema.zipCentroid.zip, zip));
  return c ?? null;
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/**
 * Create a draft. Idempotent per (agent, `clientOpId`): a retry returns the first listing with `created: false`.
 * At most 50 listings per agent and 5,000 app-wide; 300 writes per agent per hour. The ZIP's centroid fills the
 * location (`geo_source = 'zip'`) when the centroid table has the ZIP; without it the listing has no location and
 * can't be published until the agent sets one.
 */
export async function createListing(actor: Actor | null, input: unknown): Promise<{ listing: OwnerListing; created: boolean }> {
  assertCan(actor, "listing:manage");
  const data = newListingInput.parse(input);
  const { id, created } = await db().transaction(async (tx) => {
    await lockAgent(tx, actor);
    // One create at a time, app-wide: makes the replay check below and both cap counts exact (the 5,000 cap spans
    // agents). Creating a listing is rare and the transaction short, so the single lock costs nothing.
    await advisoryLock(tx, "listing-create");
    const [existing] = await tx
      .select({ id: L.id })
      .from(L)
      .where(and(eq(L.agentId, actor.id), eq(L.clientOpId, data.clientOpId)));
    if (existing) return { id: existing.id, created: false };

    const [{ mine }] = await tx.select({ mine: count() }).from(L).where(eq(L.agentId, actor.id));
    if (mine >= LIMITS.listingsPerAgent) throw new ConflictError(`You can have at most ${LIMITS.listingsPerAgent} listings. Delete a draft or a withdrawn listing first.`);
    const [{ total }] = await tx.select({ total: count() }).from(L);
    if (total >= LIMITS.listingsApp) throw new ConflictError("This site has reached its listing limit.");
    await consumeRate(tx, actor.id, "api_write", LIMITS.writesPerHour, TOO_MANY_WRITES);

    const centroid = await centroidFor(tx, data.zip);
    const [row] = await tx
      .insert(L)
      .values({
        agentId: actor.id,
        title: data.title,
        propertyType: data.propertyType,
        priceUsd: data.priceUsd,
        beds: data.beds,
        baths: data.baths,
        sqft: data.sqft,
        lotSqft: data.lotSqft,
        yearBuilt: data.yearBuilt,
        features: data.features,
        addressLine: data.addressLine,
        city: data.city,
        state: data.state,
        zip: data.zip,
        lat: centroid?.lat ?? null,
        lng: centroid?.lng ?? null,
        geoSource: centroid ? "zip" : null,
        description: data.description,
        agentNotes: data.agentNotes,
        clientOpId: data.clientOpId,
      })
      .returning({ id: L.id });
    return { id: row.id, created: true };
  });
  return { listing: await getMyListing(actor, id), created };
}

/** The listing row for update, locked, or 404 (foreign and missing ids look the same) and 409 for a stale version. */
async function lockOwnListing(tx: Tx, actor: Actor, rawId: string, version: number) {
  const id = uuidOr404(rawId);
  const [row] = await tx
    .select({
      id: L.id,
      status: L.status,
      version: L.version,
      zip: L.zip,
      lat: L.lat,
      lng: L.lng,
      geoSource: L.geoSource,
      description: L.description,
      publishedAt: L.publishedAt,
    })
    .from(L)
    .where(and(eq(L.id, id), eq(L.agentId, actor.id)))
    .for("update");
  if (!row) throw new NotFoundError();
  if (row.version !== version) throw new ConflictError("This listing changed since you opened it. Reload and try again.");
  return row;
}

/** What a listing still needs before it can be public. */
export function publishBlockers(l: { description: string; lat: number | null; lng: number | null }, photoCount: number): string[] {
  const missing: string[] = [];
  if (photoCount < 1) missing.push("at least 1 photo");
  if (l.description.length < LIMITS.minDescriptionToPublish) missing.push(`a description of at least ${LIMITS.minDescriptionToPublish} characters`);
  if (l.lat === null || l.lng === null) missing.push("a location");
  return missing;
}

async function assertPublishable(tx: Tx, l: { id: string; description: string; lat: number | null; lng: number | null }) {
  const [{ n }] = await tx.select({ n: count() }).from(schema.listingPhoto).where(eq(schema.listingPhoto.listingId, l.id));
  const missing = publishBlockers(l, n);
  if (missing.length) throw new UnprocessableError(`This listing can't be public yet. It needs ${missing.join(", ")}.`);
}

/**
 * Edit facts and/or move the status, in one versioned write: `version` must be the one the caller read (409
 * otherwise) and is bumped on success. Status changes follow `STATUS_TRANSITIONS`; whenever the result is `active`
 * or `pending` the listing must have a photo, a 200+ character description and a location. Changing the ZIP resets
 * the location to the new ZIP's centroid (or clears it when that ZIP isn't loaded).
 */
export async function updateListing(actor: Actor | null, rawId: string, input: unknown): Promise<OwnerListing> {
  assertCan(actor, "listing:manage");
  const { version, status, ...facts } = updateListingInput.parse(input);
  const id = uuidOr404(rawId);
  await db().transaction(async (tx) => {
    await lockAgent(tx, actor);
    const row = await lockOwnListing(tx, actor, id, version);
    await consumeRate(tx, actor.id, "api_write", LIMITS.writesPerHour, TOO_MANY_WRITES);

    // Undefined values are skipped by Drizzle's `set`, so only the fields the caller sent change.
    const patch: Partial<typeof L.$inferInsert> = { ...facts };

    let nextStatus: ListingStatus = row.status;
    if (status !== undefined && status !== row.status) {
      if (!STATUS_TRANSITIONS[row.status].includes(status)) throw new ConflictError(`A ${row.status} listing can't become ${status}.`);
      nextStatus = status;
      patch.status = status;
    }

    let lat = row.lat;
    let lng = row.lng;
    if (typeof facts.zip === "string" && facts.zip !== row.zip) {
      const c = await centroidFor(tx, facts.zip);
      lat = c?.lat ?? null;
      lng = c?.lng ?? null;
      patch.lat = lat;
      patch.lng = lng;
      patch.geoSource = c ? "zip" : null;
    }

    if (nextStatus === "active" || nextStatus === "pending") {
      await assertPublishable(tx, { id: row.id, description: facts.description ?? row.description, lat, lng });
    }
    if (nextStatus === "active" && row.publishedAt === null) patch.publishedAt = new Date();

    await tx
      .update(L)
      .set({ ...patch, version: row.version + 1, updatedAt: new Date() })
      .where(eq(L.id, row.id));
  });
  return getMyListing(actor, id);
}

/**
 * Set where the listing is. `zip` resets to the ZIP's centroid. `device` (an explicit tap at the property) is refused
 * when it is more than 5 miles from the ZIP's centroid; `manual` coordinates that far need `confirmFar: true` and
 * are logged as `geo.far_confirmed`. When the ZIP has no centroid there is nothing to compare with: `device` is
 * refused and `manual` needs the same confirm.
 */
export async function setListingLocation(actor: Actor | null, rawId: string, input: unknown): Promise<OwnerListing> {
  assertCan(actor, "listing:manage");
  const data = locationInput.parse(input);
  const id = uuidOr404(rawId);
  await db().transaction(async (tx) => {
    await lockAgent(tx, actor);
    const row = await lockOwnListing(tx, actor, id, data.version);
    await consumeRate(tx, actor.id, "api_write", LIMITS.writesPerHour, TOO_MANY_WRITES);
    const centroid = await centroidFor(tx, row.zip);

    let lat: number;
    let lng: number;
    let geoSource: "zip" | "device" | "manual";
    if (data.source === "zip") {
      if (!centroid) throw new ConflictError(`We don't have a centre for ZIP ${row.zip}. Enter coordinates instead.`);
      ({ lat, lng } = centroid);
      geoSource = "zip";
    } else {
      lat = round5(data.lat);
      lng = round5(data.lng);
      geoSource = data.source;
      if (!centroid) {
        if (data.source === "device") throw new UnprocessableError(`We don't have a centre for ZIP ${row.zip} to check this location against. Enter coordinates instead.`);
        if (!data.confirmFar) throw new UnprocessableError(`We don't have a centre for ZIP ${row.zip} to check these coordinates against. Confirm to save them anyway.`);
        log.info("geo.far_confirmed", { listingId: row.id, reason: "no_centroid" });
      } else {
        const miles = haversineMiles(lat, lng, centroid.lat, centroid.lng);
        if (miles > FAR_MILES) {
          const msg = `${miles.toFixed(1)} mi from ZIP ${row.zip}'s centre: check the ZIP, or enter coordinates`;
          if (data.source === "device") throw new UnprocessableError(msg);
          if (!data.confirmFar) throw new UnprocessableError(`${msg}. Confirm to save them anyway.`);
          log.info("geo.far_confirmed", { listingId: row.id, miles: Math.round(miles * 10) / 10 });
        }
      }
    }
    await tx
      .update(L)
      .set({ lat, lng, geoSource, version: row.version + 1, updatedAt: new Date() })
      .where(eq(L.id, row.id));
  });
  return getMyListing(actor, id);
}

/**
 * Delete a draft or a withdrawn listing. Photos, photo bytes, favorites, inquiries and description drafts go with it
 * (foreign keys cascade), which frees the listing and photo caps. Any other status is a 409.
 */
export async function deleteListing(actor: Actor | null, rawId: string): Promise<void> {
  assertCan(actor, "listing:manage");
  const id = uuidOr404(rawId);
  await db().transaction(async (tx) => {
    await lockAgent(tx, actor);
    const [row] = await tx
      .select({ status: L.status })
      .from(L)
      .where(and(eq(L.id, id), eq(L.agentId, actor.id)))
      .for("update");
    if (!row) throw new NotFoundError();
    if (row.status !== "draft" && row.status !== "withdrawn") throw new ConflictError("Only a draft or a withdrawn listing can be deleted. Withdraw it first.");
    await consumeRate(tx, actor.id, "api_write", LIMITS.writesPerHour, TOO_MANY_WRITES);
    await tx.delete(L).where(eq(L.id, id));
  });
}
