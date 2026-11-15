import "server-only";
import { count, eq, sql } from "drizzle-orm";
import { assertCan, uuidOr404 } from "@/lib/access";
import { type Actor, toRole } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { AGENT_REVOKED, hideInput } from "@/lib/listing-schema";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { dailyCount } from "@/lib/usage";

const MB = 1024 * 1024;
const GB = 1024 * MB;
/** The /admin banner: the shared Postgres server turns read-only at about 95% storage; warn from 70%. */
export const STORAGE_WARN_FRACTION = 0.7;

/**
 * Counts only. No names, emails, drafts, notes or inquiry content: admins see how the system is doing, not what
 * its users wrote. (Reindex's pending count is added by the search module, 14.6.)
 */
export async function adminStats(actor: Actor | null) {
  assertCan(actor, "admin:stats");
  const d = db();
  const e = env();

  const byStatus = await d.select({ status: schema.listing.status, n: count() }).from(schema.listing).groupBy(schema.listing.status);
  const [{ hidden }] = await d.select({ hidden: count() }).from(schema.listing).where(sql`${schema.listing.hiddenAt} is not null`);
  const byInquiry = await d.select({ status: schema.inquiry.status, n: count() }).from(schema.inquiry).groupBy(schema.inquiry.status);
  const roleRows = await d.select({ role: schema.user.role, n: count() }).from(schema.user).groupBy(schema.user.role);
  const users = { user: 0, agent: 0, admin: 0 };
  for (const r of roleRows) users[toRole(r.role)] += r.n;

  const [photo] = await d
    .select({ n: count(), bytes: sql<string>`coalesce(sum(${schema.listingPhoto.bytesTotal}), 0)` })
    .from(schema.listingPhoto);

  const [ai, embedDoc, embedQuery] = await Promise.all([dailyCount("ai"), dailyCount("embed_doc"), dailyCount("embed_query")]);

  const [{ appBytes }] = await d.execute<{ appBytes: string }>(sql`select pg_database_size(current_database())::text as "appBytes"`);
  let serverBytes = Number(appBytes);
  let serverIsApproximate = true;
  try {
    // Sums every database on the server; needs only CONNECT, which is granted to PUBLIC by default.
    const [row] = await d.execute<{ total: string }>(sql`select sum(pg_database_size(datname))::text as total from pg_database where datallowconn`);
    if (row?.total) {
      serverBytes = Number(row.total);
      serverIsApproximate = false;
    }
  } catch {
    // The role can't read the others: fall back to this database alone and say so.
  }
  const provisioned = e.DB_SERVER_STORAGE_GB * GB;

  return {
    listings: {
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])) as Partial<Record<(typeof schema.listing.status.enumValues)[number], number>>,
      hidden,
    },
    inquiries: { byStatus: Object.fromEntries(byInquiry.map((r) => [r.status, r.n])) as Partial<Record<(typeof schema.inquiry.status.enumValues)[number], number>> },
    users,
    photos: { count: photo.n, bytes: Number(photo.bytes), capBytes: e.PHOTO_STORE_CAP_MB * MB },
    usageToday: {
      ai: { used: ai, cap: e.AI_DAILY_CAP },
      embedDoc: { used: embedDoc, cap: e.EMBED_DOC_DAILY_CAP },
      embedQuery: { used: embedQuery, cap: e.EMBED_QUERY_DAILY_CAP },
    },
    database: {
      appBytes: Number(appBytes),
      serverBytes,
      serverIsApproximate,
      provisionedBytes: provisioned,
      warn: serverBytes / provisioned >= STORAGE_WARN_FRACTION,
    },
  };
}

/**
 * Hide an active or pending listing with a reason (it leaves search, and its page and photos 404), or unhide it.
 * Hiding over an `agent_revoked` hide replaces that reason with the admin's, so a later re-grant of `agent` does
 * not unhide it; hiding an already admin-hidden listing changes nothing. A listing hidden because its agent was
 * revoked can't be unhidden here: grant the role again. Hiding doesn't change the listing's `version`.
 */
export async function hideListing(actor: Actor | null, rawId: string, input: unknown) {
  assertCan(actor, "admin:hide");
  const id = uuidOr404(rawId);
  const { hidden, reason } = hideInput.parse(input);
  const L = schema.listing;
  const result = await db().transaction(async (tx) => {
    // Lock order is user row, then listing row, the same as setUserRole (which locks the user FOR UPDATE and then
    // updates listings). Reading the owner's role under a FOR SHARE lock also means an unhide can't race a revoke:
    // either the revoke committed first (we see `user` and refuse) or it waits for us and then hides the listing.
    const [owner] = await tx.select({ agentId: L.agentId }).from(L).where(eq(L.id, id));
    if (!owner) throw new NotFoundError();
    const [agent] = await tx.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, owner.agentId)).for("share");
    const [row] = await tx
      .select({ id: L.id, status: L.status, hiddenAt: L.hiddenAt, hiddenReason: L.hiddenReason })
      .from(L)
      .where(eq(L.id, id))
      .for("update");
    if (!row) throw new NotFoundError();
    if (hidden) {
      if (row.status !== "active" && row.status !== "pending") throw new ConflictError("Only an active or pending listing can be hidden.");
      if (row.hiddenAt && row.hiddenReason !== AGENT_REVOKED) return { id, hidden: true, changed: false };
      await tx.update(L).set({ hiddenAt: row.hiddenAt ?? new Date(), hiddenReason: reason }).where(eq(L.id, id));
      return { id, hidden: true, changed: true };
    }
    if (!row.hiddenAt) return { id, hidden: false, changed: false };
    if (row.hiddenReason === AGENT_REVOKED) throw new ConflictError("Hidden because the agent's role was revoked. Grant the agent role again to unhide it.");
    // Never expose a listing whose agent is no longer an agent.
    if (!agent || toRole(agent.role) !== "agent") throw new ConflictError("This listing's owner is no longer an agent.");
    await tx.update(L).set({ hiddenAt: null, hiddenReason: null }).where(eq(L.id, id));
    return { id, hidden: false, changed: true };
  });
  if (result.changed) log.info(result.hidden ? "listing.hidden" : "listing.unhidden", { actorId: actor.id, listingId: id });
  return result;
}

