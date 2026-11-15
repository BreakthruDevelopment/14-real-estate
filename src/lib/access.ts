import "server-only";
import { type SQL, and, eq, isNull } from "drizzle-orm";
import { type Actor, ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { schema } from "@/lib/db";

/**
 * Access rules for this app, in one place. The template's `can()` (admin passes everything) is deliberately not
 * used: here admin sees counts and moderates, and never reads drafts, inquiries or agent notes.
 *
 * | Who | Allowed | Test |
 * | --- | --- | --- |
 * | Public (no actor) | `active` and not hidden listings, their photos, `zip_centroid`; never `agent_notes`, drafts, the agent's email | access.integration |
 * | `user` (buyer) | Public, plus own favorites and own inquiries (on public listings) | access.integration |
 * | `agent` | Listings with `agent_id = actor.id` in any status, their photos and drafts, inquiries on them (with the buyer's name and email). Another agent's listing id is a 404 on every read and write | access.integration, listings.integration |
 * | `admin` | Counts, roles, hide and unhide. Content functions are 403 (agent functions) or see only public rows | access.integration |
 *
 * Two kinds of "no": a wrong ROLE is 403 (`assertCan`); a right role asking for a row that isn't theirs, or doesn't
 * exist, is 404 (`NotFoundError`), so a stranger can't tell a missing id from someone else's.
 */
export type Capability =
  | "listing:manage" // agent: create, edit, photos, location, publish, status, delete own listings
  | "inquiry:manage" // agent: read and update inquiries on own listings
  | "favorite:manage" // buyer
  | "inquiry:create" // buyer
  | "inquiry:read-own" // buyer
  | "admin:stats"
  | "admin:roles"
  | "admin:hide";

const GRANTS: Record<Capability, Actor["role"][]> = {
  "listing:manage": ["agent"],
  "inquiry:manage": ["agent"],
  "favorite:manage": ["user"],
  "inquiry:create": ["user"],
  "inquiry:read-own": ["user"],
  "admin:stats": ["admin"],
  "admin:roles": ["admin"],
  "admin:hide": ["admin"],
};

export function can(actor: Actor | null | undefined, capability: Capability): boolean {
  return !!actor && GRANTS[capability].includes(actor.role);
}

/** Every data function calls this first. 401 without an actor, 403 for the wrong role. */
export function assertCan(actor: Actor | null | undefined, capability: Capability): asserts actor is Actor {
  if (!actor) throw new UnauthorizedError();
  if (!can(actor, capability)) throw new ForbiddenError();
}

/** What anyone (signed in or not) may see: active and not hidden. Put this in every public listing query. */
export function publicListing(): SQL {
  return and(eq(schema.listing.status, "active"), isNull(schema.listing.hiddenAt)) as SQL;
}

/** Is this row visible to the public? For rows already loaded. */
export function isPublic(row: { status: string; hiddenAt: Date | null }): boolean {
  return row.status === "active" && row.hiddenAt === null;
}

/** The listing belongs to this actor acting as an agent. */
export function ownsListing(actor: Actor | null | undefined, row: { agentId: string }): boolean {
  return !!actor && actor.role === "agent" && row.agentId === actor.id;
}

/** Ids that aren't uuids can't exist: answer 404 like any other miss instead of a 400 that confirms the format. */
export function uuidOr404(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundError();
  return id.toLowerCase();
}
