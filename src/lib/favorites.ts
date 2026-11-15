import "server-only";
import { and, count, desc, eq } from "drizzle-orm";
import { assertCan, publicListing, uuidOr404 } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { LIMITS } from "@/lib/listing-schema";
import { advisoryLock, consumeRate } from "@/lib/usage";

/** Buyers' favorites. Only `user`-role accounts (buyers); a favorite is private to its owner. */

/** Favorite a listing that is public right now (a draft, a hidden or someone else's non-public id is a 404). Idempotent. */
export async function addFavorite(actor: Actor | null, rawListingId: string): Promise<{ added: boolean }> {
  assertCan(actor, "favorite:manage");
  const listingId = uuidOr404(rawListingId);
  return db().transaction(async (tx) => {
    await advisoryLock(tx, `favorite:${actor.id}`);
    const [visible] = await tx
      .select({ id: schema.listing.id })
      .from(schema.listing)
      .where(and(eq(schema.listing.id, listingId), publicListing()));
    if (!visible) throw new NotFoundError();
    const [existing] = await tx
      .select({ listingId: schema.favorite.listingId })
      .from(schema.favorite)
      .where(and(eq(schema.favorite.userId, actor.id), eq(schema.favorite.listingId, listingId)));
    if (existing) return { added: false };
    const [{ n }] = await tx.select({ n: count() }).from(schema.favorite).where(eq(schema.favorite.userId, actor.id));
    if (n >= LIMITS.favoritesPerUser) throw new ConflictError(`You can save at most ${LIMITS.favoritesPerUser} favorites.`);
    await consumeRate(tx, actor.id, "api_write", LIMITS.writesPerHour, "Too many changes this hour. Try again later.");
    await tx.insert(schema.favorite).values({ userId: actor.id, listingId });
    return { added: true };
  });
}

/** Remove a favorite. Works for any listing (so a favorite of a listing that has since been hidden can be cleared). */
export async function removeFavorite(actor: Actor | null, rawListingId: string): Promise<{ removed: boolean }> {
  assertCan(actor, "favorite:manage");
  const listingId = uuidOr404(rawListingId);
  const rows = await db()
    .delete(schema.favorite)
    .where(and(eq(schema.favorite.userId, actor.id), eq(schema.favorite.listingId, listingId)))
    .returning({ listingId: schema.favorite.listingId });
  return { removed: rows.length > 0 };
}

/** The buyer's favorites that are still public, newest first. Hidden, draft and withdrawn listings drop out of the list. */
export async function listFavorites(actor: Actor | null) {
  assertCan(actor, "favorite:manage");
  const L = schema.listing;
  return db()
    .select({
      listingId: L.id,
      title: L.title,
      propertyType: L.propertyType,
      priceUsd: L.priceUsd,
      beds: L.beds,
      baths: L.baths,
      city: L.city,
      state: L.state,
      zip: L.zip,
      favoritedAt: schema.favorite.createdAt,
    })
    .from(schema.favorite)
    .innerJoin(L, eq(L.id, schema.favorite.listingId))
    .where(and(eq(schema.favorite.userId, actor.id), publicListing()))
    .orderBy(desc(schema.favorite.createdAt))
    .limit(LIMITS.favoritesPerUser);
}
