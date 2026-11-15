import "server-only";
import { type SQL, and, count, desc, eq, gt, sql } from "drizzle-orm";
import { assertCan, publicListing, uuidOr404 } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { INQUIRY_STATUSES, LIMITS, inquiryInput, inquiryStatusInput } from "@/lib/listing-schema";
import { lockAgent } from "@/lib/listings";
import { advisoryLock, consumeRate } from "@/lib/usage";

/**
 * Inquiries: a buyer writes to a listing's agent. The agent sees the buyer's name and email (the page says so before
 * sending); nobody else does. Admins get counts only (see admin.ts).
 */

const I = schema.inquiry;

export async function createInquiry(actor: Actor | null, input: unknown): Promise<{ inquiry: typeof I.$inferSelect; created: boolean }> {
  assertCan(actor, "inquiry:create");
  const data = inquiryInput.parse(input);
  return db().transaction(async (tx) => {
    // One inquiry at a time per buyer: the replay check and the limits below are then exact.
    await advisoryLock(tx, `inquiry-create:${actor.id}`);
    const [replay] = await tx
      .select()
      .from(I)
      .where(and(eq(I.buyerId, actor.id), eq(I.clientOpId, data.clientOpId)));
    if (replay) {
      if (replay.listingId !== data.listingId) throw new ConflictError("That request id was already used for another listing.");
      return { inquiry: replay, created: false };
    }

    const [visible] = await tx
      .select({ id: schema.listing.id })
      .from(schema.listing)
      .where(and(eq(schema.listing.id, data.listingId), publicListing()));
    if (!visible) throw new NotFoundError();

    const [{ day }] = await tx
      .select({ day: count() })
      .from(I)
      .where(and(eq(I.buyerId, actor.id), gt(I.createdAt, sql`now() - interval '1 day'`)));
    if (day >= LIMITS.inquiriesPerDay) throw new TooManyRequestsError("You've sent the most inquiries allowed in a day. Try again tomorrow.");
    await consumeRate(tx, actor.id, "inquiry", LIMITS.inquiriesPerHour, "You've sent several inquiries this hour. Try again later.");

    // Any unique violation (the op id raced, or an open inquiry on this listing exists) skips the insert.
    const [row] = await tx.insert(I).values({ listingId: data.listingId, buyerId: actor.id, message: data.message, clientOpId: data.clientOpId }).onConflictDoNothing().returning();
    if (!row) throw new ConflictError("You already have an open inquiry on this listing.");
    return { inquiry: row, created: true };
  });
}

/** The buyer's own inquiries (message and status, plus the listing's title). Never the agent's email. */
export async function listMyInquiries(actor: Actor | null) {
  assertCan(actor, "inquiry:read-own");
  return db()
    .select({
      id: I.id,
      listingId: I.listingId,
      listingTitle: schema.listing.title,
      message: I.message,
      status: I.status,
      createdAt: I.createdAt,
    })
    .from(I)
    .innerJoin(schema.listing, eq(schema.listing.id, I.listingId))
    .where(eq(I.buyerId, actor.id))
    .orderBy(desc(I.createdAt))
    .limit(200);
}

/** Inquiries on the agent's own listings, with the buyer's name and email. */
export async function listAgentInquiries(actor: Actor | null, opts: { status?: (typeof INQUIRY_STATUSES)[number]; listingId?: string } = {}) {
  assertCan(actor, "inquiry:manage");
  const where: (SQL | undefined)[] = [eq(schema.listing.agentId, actor.id)];
  if (opts.status) where.push(eq(I.status, opts.status));
  if (opts.listingId) where.push(eq(I.listingId, uuidOr404(opts.listingId)));
  return db()
    .select({
      id: I.id,
      listingId: I.listingId,
      listingTitle: schema.listing.title,
      message: I.message,
      status: I.status,
      createdAt: I.createdAt,
      buyerName: schema.user.name,
      buyerEmail: schema.user.email,
    })
    .from(I)
    .innerJoin(schema.listing, eq(schema.listing.id, I.listingId))
    .innerJoin(schema.user, eq(schema.user.id, I.buyerId))
    .where(and(...where))
    .orderBy(desc(I.createdAt))
    .limit(200);
}

/** Mark an inquiry on the agent's own listing open, contacted or closed. Foreign and missing ids are a 404. */
export async function updateInquiryStatus(actor: Actor | null, rawId: string, input: unknown) {
  assertCan(actor, "inquiry:manage");
  const id = uuidOr404(rawId);
  const { status } = inquiryStatusInput.parse(input);
  return db().transaction(async (tx) => {
    await lockAgent(tx, actor);
    // Same order as deleteListing (agent's write allowance, then the rows it touches), so the two never deadlock:
    // take the allowance's lock first, even though a no-op change won't spend it.
    await advisoryLock(tx, `rate:api_write:${actor.id}`);
    const [row] = await tx
      .select({ id: I.id, listingId: I.listingId, buyerId: I.buyerId, status: I.status })
      .from(I)
      .innerJoin(schema.listing, eq(schema.listing.id, I.listingId))
      .where(and(eq(I.id, id), eq(schema.listing.agentId, actor.id)))
      .for("update", { of: I });
    if (!row) throw new NotFoundError();
    if (row.status === status) return { id, status };
    await consumeRate(tx, actor.id, "api_write", LIMITS.writesPerHour, "Too many changes this hour. Try again later.");
    if (status === "open") {
      // Reopening would break "one open inquiry per buyer per listing" if the buyer has written again since.
      const [other] = await tx
        .select({ id: I.id })
        .from(I)
        .where(and(eq(I.buyerId, row.buyerId), eq(I.listingId, row.listingId), eq(I.status, "open")));
      if (other) throw new ConflictError("This buyer already has another open inquiry on this listing.");
    }
    await tx.update(I).set({ status, updatedAt: new Date() }).where(eq(I.id, id));
    return { id, status };
  });
}
