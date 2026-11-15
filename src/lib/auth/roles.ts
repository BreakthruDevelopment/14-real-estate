import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { assertCan } from "@/lib/access";
import { type Actor, toRole } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { AGENT_REVOKED, LIMITS, roleInput } from "@/lib/listing-schema";
import { log } from "@/lib/log";
import { consumeRate } from "@/lib/usage";

export type RoleChange = { userId: string; role: "user" | "agent"; changed: boolean; hidden: number; unhidden: number };

/**
 * The only way a role changes (`POST /api/admin/roles`): Better Auth's own set-role, create-user, update-user and
 * remove-user are disabled, so nothing can skip the hide/unhide below.
 *
 * Revoking `agent` hides that agent's `active` and `pending` listings that are not already hidden
 * (`hidden_reason = 'agent_revoked'`), so an admin's own hide and its reason are never overwritten. Granting `agent`
 * again unhides only the listings stamped `agent_revoked`; an admin-hidden listing stays hidden. The role write and
 * the hide/unhide share one transaction, and the user row is locked FOR UPDATE, which also makes any agent write in
 * flight (they lock it FOR SHARE, see `lockAgent`) finish first.
 *
 * Admins' roles are not changed here (an admin is made out of band), and only `user` and `agent` can be granted.
 */
export async function setUserRole(actor: Actor | null, input: unknown): Promise<RoleChange> {
  assertCan(actor, "admin:roles");
  const { userId, role } = roleInput.parse(input);
  const result = await db().transaction(async (tx) => {
    const [target] = await tx
      .select({ id: schema.user.id, role: schema.user.role })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .for("update");
    if (!target) throw new NotFoundError("User not found");
    const previous = toRole(target.role);
    if (previous === "admin") throw new ConflictError("An admin's role can't be changed here.");
    if (previous === role) return { userId, role, changed: false, hidden: 0, unhidden: 0 };

    // A real change costs the acting admin one write from the hourly allowance (it holds locks that block the agent's writes).
    await consumeRate(tx, actor.id, "api_write", LIMITS.writesPerHour, "Too many changes this hour. Try again later.");
    await tx.update(schema.user).set({ role, updatedAt: new Date() }).where(eq(schema.user.id, userId));

    const L = schema.listing;
    let hidden = 0;
    let unhidden = 0;
    if (role === "user") {
      const rows = await tx
        .update(L)
        .set({ hiddenAt: new Date(), hiddenReason: AGENT_REVOKED })
        .where(and(eq(L.agentId, userId), inArray(L.status, ["active", "pending"]), isNull(L.hiddenAt)))
        .returning({ id: L.id });
      hidden = rows.length;
    } else {
      const rows = await tx
        .update(L)
        .set({ hiddenAt: null, hiddenReason: null })
        .where(and(eq(L.agentId, userId), eq(L.hiddenReason, AGENT_REVOKED)))
        .returning({ id: L.id });
      unhidden = rows.length;
    }
    return { userId, role, changed: true, hidden, unhidden };
  });
  if (result.changed) log.info("role.changed", { actorId: actor.id, userId, to: role, hidden: result.hidden, unhidden: result.unhidden });
  return result;
}
