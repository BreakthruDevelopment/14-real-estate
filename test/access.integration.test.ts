/**
 * One test per access rule in src/lib/access.ts (spec 14, "Access rules"): who may read and write what, against a
 * real Postgres (TEST_DATABASE_URL). Pattern for each rule: owner allowed, other user blocked, admin allowed
 * (or, where the spec says admins see counts only, admin blocked from content).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestActor, addPhoto, cleanup, facts, makeUser, publish, seedCentroid } from "./helpers";

const url = process.env.TEST_DATABASE_URL;
const P = "ac";

describe.skipIf(!url)("access rules (Postgres)", () => {
  let sql: postgres.Sql;
  let agentA: TestActor;
  let agentB: TestActor;
  let buyer: TestActor;
  let buyer2: TestActor;
  let admin: TestActor;
  let L: typeof import("@/lib/listings");
  let I: typeof import("@/lib/inquiries");
  let F: typeof import("@/lib/favorites");
  let A: typeof import("@/lib/admin");
  let R: typeof import("@/lib/auth/roles");

  // listings owned by agent A in each state
  let draft: { id: string; version: number };
  let active: { id: string; version: number };
  let hiddenActive: { id: string };

  const newListing = async (agent: TestActor, o: Record<string, unknown> = {}) => (await L.createListing(agent, facts(o))).listing;
  const makeActive = async (agent: TestActor, o: Record<string, unknown> = {}) => {
    const l = await newListing(agent, o);
    await publish(sql, L.updateListing, agent, l);
    return l;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup(sql, P);
    await seedCentroid(sql);
    agentA = await makeUser(sql, P, "agentA", "agent");
    agentB = await makeUser(sql, P, "agentB", "agent");
    buyer = await makeUser(sql, P, "buyer", "user");
    buyer2 = await makeUser(sql, P, "buyer2", "user");
    admin = await makeUser(sql, P, "admin", "admin");
    L = await import("@/lib/listings");
    I = await import("@/lib/inquiries");
    F = await import("@/lib/favorites");
    A = await import("@/lib/admin");
    R = await import("@/lib/auth/roles");
    draft = await newListing(agentA, { title: "Draft of A" });
    active = await makeActive(agentA, { title: "Active of A" });
    const h = await makeActive(agentA, { title: "Hidden of A" });
    await A.hideListing(admin, h.id, { hidden: true, reason: "test hide" });
    hiddenActive = h;
  });

  afterAll(async () => {
    await cleanup(sql, P);
    await sql.end();
  });

  describe("public", () => {
    it("sees an active, not hidden listing, with no private fields", async () => {
      const { listing, viewer } = await L.getListing(null, active.id);
      expect(viewer).toBe("public");
      expect(listing.title).toBe("Active of A");
      const keys = Object.keys(listing);
      for (const forbidden of ["agentNotes", "agentId", "hiddenAt", "hiddenReason", "version", "embedding", "tsv", "searchText", "embedHash", "clientOpId"]) {
        expect(keys).not.toContain(forbidden);
      }
      expect(JSON.stringify(listing)).not.toContain("private note for the agent");
    });

    it("gets a 404 for a draft, a hidden listing, a pending listing and a missing or malformed id", async () => {
      const pending = await makeActive(agentA, { title: "Pending of A" });
      const [{ version }] = await sql`select version from listing where id = ${pending.id}`;
      await L.updateListing(agentA, pending.id, { version, status: "pending" });
      for (const id of [draft.id, hiddenActive.id, pending.id, crypto.randomUUID(), "not-a-uuid", "1; drop table listing"]) {
        await expect(L.getListing(null, id), id).rejects.toMatchObject({ status: 404 });
      }
    });

    it("gets a 404 for a draft as a buyer, another agent and an admin too (admins see counts, not content)", async () => {
      for (const who of [buyer, agentB, admin]) {
        await expect(L.getListing(who, draft.id), who.id).rejects.toMatchObject({ status: 404 });
        await expect(L.getListing(who, hiddenActive.id), who.id).rejects.toMatchObject({ status: 404 });
      }
    });

    it("sees the listing's photos as metadata only, with a cache-busting token", async () => {
      const { photos } = await L.getListing(null, active.id);
      expect(photos).toHaveLength(1);
      expect(Object.keys(photos[0]).sort()).toEqual(["alt", "height", "id", "position", "v", "width"]);
      expect(photos[0].v).toHaveLength(8);
    });
  });

  describe("agent: own listings only", () => {
    it("owner reads a draft, a hidden listing and notes; the same call answers 404 for another agent", async () => {
      const own = await L.getMyListing(agentA, draft.id);
      expect(own.agentNotes).toBe("private note for the agent");
      const { listing, viewer } = await L.getListing(agentA, draft.id);
      expect(viewer).toBe("owner");
      expect(listing).toMatchObject({ status: "draft" });
      const hidden = await L.getListing(agentA, hiddenActive.id);
      expect(hidden.listing).toMatchObject({ hiddenReason: "test hide" });
      await expect(L.getMyListing(agentB, draft.id)).rejects.toMatchObject({ status: 404 });
      await expect(L.getListing(agentB, draft.id)).rejects.toMatchObject({ status: 404 });
    });

    it("lists only the agent's own listings", async () => {
      const mine = await L.listMyListings(agentA);
      expect(mine.map((l) => l.id)).toEqual(expect.arrayContaining([draft.id, active.id, hiddenActive.id]));
      expect(await L.listMyListings(agentB)).toEqual([]);
    });

    it("another agent gets 404 on every write, id guessing included", async () => {
      await expect(L.updateListing(agentB, draft.id, { version: draft.version, title: "mine now" })).rejects.toMatchObject({ status: 404 });
      await expect(L.setListingLocation(agentB, draft.id, { source: "zip", version: draft.version })).rejects.toMatchObject({ status: 404 });
      await expect(L.deleteListing(agentB, draft.id)).rejects.toMatchObject({ status: 404 });
      await expect(L.deleteListing(agentB, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
      // A missing id and someone else's id are indistinguishable.
      const missing = await L.updateListing(agentB, crypto.randomUUID(), { version: 1, title: "x" }).catch((e) => e);
      const foreign = await L.updateListing(agentB, draft.id, { version: 1, title: "x" }).catch((e) => e);
      expect(foreign.status).toBe(missing.status);
      expect(foreign.message).toBe(missing.message);
      expect((await sql`select title from listing where id = ${draft.id}`)[0].title).toBe("Draft of A");
    });

    it("buyers and admins can't use agent functions (403), signed-out callers get 401", async () => {
      for (const who of [buyer, admin]) {
        await expect(L.createListing(who, facts()), who.id).rejects.toMatchObject({ status: 403 });
        await expect(L.getMyListing(who, active.id), who.id).rejects.toMatchObject({ status: 403 });
        await expect(L.listMyListings(who), who.id).rejects.toMatchObject({ status: 403 });
        await expect(L.updateListing(who, active.id, { version: 1, title: "x" }), who.id).rejects.toMatchObject({ status: 403 });
        await expect(L.deleteListing(who, draft.id), who.id).rejects.toMatchObject({ status: 403 });
        await expect(I.listAgentInquiries(who), who.id).rejects.toMatchObject({ status: 403 });
      }
      await expect(L.createListing(null, facts())).rejects.toMatchObject({ status: 401 });
    });

    it("a stale session can't write after the role was revoked: the role is re-read in the transaction", async () => {
      const ex = await makeUser(sql, P, "exagent", "user"); // the DB says user; the caller still carries 'agent'
      await expect(L.createListing({ id: ex.id, role: "agent" }, facts())).rejects.toMatchObject({ status: 403 });
      await sql`update "user" set banned = true where id = ${agentB.id}`;
      await expect(L.createListing(agentB, facts())).rejects.toMatchObject({ status: 403 });
      await sql`update "user" set banned = false where id = ${agentB.id}`;
    });
  });

  describe("buyer: own favorites", () => {
    it("favorites a public listing, idempotently, and sees only their own", async () => {
      await expect(F.addFavorite(buyer, active.id)).resolves.toEqual({ added: true });
      await expect(F.addFavorite(buyer, active.id)).resolves.toEqual({ added: false });
      expect((await F.listFavorites(buyer)).map((f) => f.listingId)).toEqual([active.id]);
      expect(await F.listFavorites(buyer2)).toEqual([]);
      // Another buyer removing it removes nothing of buyer's.
      await expect(F.removeFavorite(buyer2, active.id)).resolves.toEqual({ removed: false });
      expect(await F.listFavorites(buyer)).toHaveLength(1);
    });

    it("can't favorite a draft or a hidden listing (404), and a favorite drops out of the list once its listing is hidden", async () => {
      await expect(F.addFavorite(buyer, draft.id)).rejects.toMatchObject({ status: 404 });
      await expect(F.addFavorite(buyer, hiddenActive.id)).rejects.toMatchObject({ status: 404 });
      await expect(F.addFavorite(buyer, "nope")).rejects.toMatchObject({ status: 404 });
      const extra = await makeActive(agentA, { title: "Soon hidden" });
      await F.addFavorite(buyer, extra.id);
      expect(await F.listFavorites(buyer)).toHaveLength(2);
      await A.hideListing(admin, extra.id, { hidden: true, reason: "spam" });
      expect((await F.listFavorites(buyer)).map((f) => f.listingId)).toEqual([active.id]);
      // The buyer can still clear it.
      await expect(F.removeFavorite(buyer, extra.id)).resolves.toEqual({ removed: true });
    });

    it("agents and admins have no favorites (403); signed-out is 401", async () => {
      for (const who of [agentA, admin]) {
        await expect(F.addFavorite(who, active.id), who.id).rejects.toMatchObject({ status: 403 });
        await expect(F.listFavorites(who), who.id).rejects.toMatchObject({ status: 403 });
        await expect(F.removeFavorite(who, active.id), who.id).rejects.toMatchObject({ status: 403 });
      }
      await expect(F.listFavorites(null)).rejects.toMatchObject({ status: 401 });
    });
  });

  describe("buyer and agent: inquiries", () => {
    let inquiryId: string;

    it("a buyer writes to a public listing's agent and sees only their own inquiries, with no agent contact details", async () => {
      const { inquiry, created } = await I.createInquiry(buyer, { listingId: active.id, message: "Is it still available?", clientOpId: crypto.randomUUID() });
      expect(created).toBe(true);
      inquiryId = inquiry.id;
      const mine = await I.listMyInquiries(buyer);
      expect(mine.map((i) => i.id)).toEqual([inquiryId]);
      expect(JSON.stringify(mine)).not.toContain("@test.local");
      expect(await I.listMyInquiries(buyer2)).toEqual([]);
    });

    it("can't inquire on a draft or hidden listing (404); agents and admins can't inquire (403)", async () => {
      for (const id of [draft.id, hiddenActive.id]) {
        await expect(I.createInquiry(buyer2, { listingId: id, message: "hi", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 404 });
      }
      for (const who of [agentB, admin]) {
        await expect(I.createInquiry(who, { listingId: active.id, message: "hi", clientOpId: crypto.randomUUID() }), who.id).rejects.toMatchObject({ status: 403 });
        await expect(I.listMyInquiries(who), who.id).rejects.toMatchObject({ status: 403 });
      }
    });

    it("the listing's agent sees the inquiry with the buyer's name and email; another agent sees nothing and gets 404 on it", async () => {
      const seen = await I.listAgentInquiries(agentA);
      const row = seen.find((i) => i.id === inquiryId);
      expect(row).toMatchObject({ buyerEmail: `${buyer.id}@test.local`, listingTitle: "Active of A" });
      expect(await I.listAgentInquiries(agentB)).toEqual([]);
      await expect(I.updateInquiryStatus(agentB, inquiryId, { status: "closed" })).rejects.toMatchObject({ status: 404 });
      await expect(I.updateInquiryStatus(agentB, "nope", { status: "closed" })).rejects.toMatchObject({ status: 404 });
      await expect(I.updateInquiryStatus(buyer, inquiryId, { status: "closed" })).rejects.toMatchObject({ status: 403 });
      await expect(I.updateInquiryStatus(admin, inquiryId, { status: "closed" })).rejects.toMatchObject({ status: 403 });
      expect((await sql`select status from inquiry where id = ${inquiryId}`)[0].status).toBe("open");
      await expect(I.updateInquiryStatus(agentA, inquiryId, { status: "contacted" })).resolves.toMatchObject({ status: "contacted" });
    });
  });

  describe("admin: counts, roles and hide only", () => {
    it("gets counts with no names, emails, notes or messages; everyone else is refused", async () => {
      const stats = await A.adminStats(admin);
      expect(stats.listings.byStatus.active).toBeGreaterThanOrEqual(1);
      expect(stats.users.agent).toBeGreaterThanOrEqual(2);
      expect(stats.photos.capBytes).toBe(600 * 1024 * 1024);
      expect(stats.database.appBytes).toBeGreaterThan(0);
      const text = JSON.stringify(stats);
      for (const secret of ["@test.local", "private note for the agent", "Is it still available?", "Craftsman"]) expect(text).not.toContain(secret);
      for (const who of [agentA, buyer]) await expect(A.adminStats(who)).rejects.toMatchObject({ status: 403 });
      await expect(A.adminStats(null)).rejects.toMatchObject({ status: 401 });
    });

    it("hides and unhides an active listing with a reason; the public 404s while hidden; others can't", async () => {
      const l = await makeActive(agentA, { title: "To hide" });
      await expect(A.hideListing(agentA, l.id, { hidden: true, reason: "x" })).rejects.toMatchObject({ status: 403 });
      await expect(A.hideListing(buyer, l.id, { hidden: true, reason: "x" })).rejects.toMatchObject({ status: 403 });
      await expect(A.hideListing(admin, l.id, { hidden: true })).rejects.toMatchObject({ name: "ZodError" });
      await expect(A.hideListing(admin, l.id, { hidden: true, reason: "agent_revoked" })).rejects.toMatchObject({ name: "ZodError" });
      await expect(A.hideListing(admin, l.id, { hidden: true, reason: "nul\0" })).rejects.toMatchObject({ name: "ZodError" });
      await expect(A.hideListing(admin, crypto.randomUUID(), { hidden: true, reason: "x" })).rejects.toMatchObject({ status: 404 });
      await expect(A.hideListing(admin, draft.id, { hidden: true, reason: "x" })).rejects.toMatchObject({ status: 409 });
      await expect(A.hideListing(admin, l.id, { hidden: true, reason: "misleading photos" })).resolves.toMatchObject({ changed: true });
      await expect(L.getListing(null, l.id)).rejects.toMatchObject({ status: 404 });
      expect((await L.getListing(agentA, l.id)).listing).toMatchObject({ hiddenReason: "misleading photos" });
      // Hiding again keeps the first reason.
      await expect(A.hideListing(admin, l.id, { hidden: true, reason: "second" })).resolves.toMatchObject({ changed: false });
      expect((await sql`select hidden_reason from listing where id = ${l.id}`)[0].hidden_reason).toBe("misleading photos");
      await expect(A.hideListing(admin, l.id, { hidden: false })).resolves.toMatchObject({ changed: true, hidden: false });
      expect((await L.getListing(null, l.id)).viewer).toBe("public");
    });

    it("never reads a draft or an inquiry: there is no admin path to either", async () => {
      await expect(L.getListing(admin, draft.id)).rejects.toMatchObject({ status: 404 });
      await expect(I.listAgentInquiries(admin)).rejects.toMatchObject({ status: 403 });
      await expect(I.listMyInquiries(admin)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("revoking and granting the agent role", () => {
    it("revoking hides the agent's active and pending listings (not drafts); an admin-hidden one keeps its reason; re-granting unhides only the revoked ones", async () => {
      const ag = await makeUser(sql, P, "revokee", "agent");
      const a1 = await makeActive(ag, { title: "R active" });
      const a2 = await makeActive(ag, { title: "R pending" });
      await L.updateListing(ag, a2.id, { version: (await sql`select version from listing where id = ${a2.id}`)[0].version, status: "pending" });
      const a3 = await makeActive(ag, { title: "R admin hidden" });
      await A.hideListing(admin, a3.id, { hidden: true, reason: "admin said so" });
      const d = await newListing(ag, { title: "R draft" });
      const sold = await makeActive(ag, { title: "R sold" });
      await L.updateListing(ag, sold.id, { version: (await sql`select version from listing where id = ${sold.id}`)[0].version, status: "sold" });
      const [adminHiddenBefore] = await sql`select hidden_at from listing where id = ${a3.id}`;

      await expect(R.setUserRole(admin, { userId: ag.id, role: "user" })).resolves.toMatchObject({ changed: true, hidden: 2 });

      const state = async (id: string) => (await sql`select hidden_at, hidden_reason from listing where id = ${id}`)[0];
      expect(await state(a1.id)).toMatchObject({ hidden_reason: "agent_revoked" });
      expect(await state(a2.id)).toMatchObject({ hidden_reason: "agent_revoked" });
      expect(await state(a3.id)).toMatchObject({ hidden_reason: "admin said so", hidden_at: adminHiddenBefore.hidden_at });
      expect((await state(d.id)).hidden_at).toBeNull();
      expect((await state(sold.id)).hidden_at).toBeNull();
      // Public pages 404, and the revoked agent can't act (the stale agent role in the caller is ignored).
      await expect(L.getListing(null, a1.id)).rejects.toMatchObject({ status: 404 });
      await expect(L.updateListing(ag, a1.id, { version: 1, title: "still mine?" })).rejects.toMatchObject({ status: 403 });
      // An admin can't unhide a revoked agent's listing from the moderation route either.
      await expect(A.hideListing(admin, a1.id, { hidden: false })).rejects.toMatchObject({ status: 409 });

      await expect(R.setUserRole(admin, { userId: ag.id, role: "agent" })).resolves.toMatchObject({ changed: true, unhidden: 2 });
      expect(await state(a1.id)).toMatchObject({ hidden_at: null, hidden_reason: null });
      expect(await state(a2.id)).toMatchObject({ hidden_at: null, hidden_reason: null });
      expect(await state(a3.id)).toMatchObject({ hidden_reason: "admin said so", hidden_at: adminHiddenBefore.hidden_at });
      await expect(L.getListing(null, a3.id)).rejects.toMatchObject({ status: 404 });
      expect((await L.getListing(null, a1.id)).viewer).toBe("public");
    });

    it("an admin hide placed over an agent_revoked hide survives a re-grant", async () => {
      const ag = await makeUser(sql, P, "revokee2", "agent");
      const l = await makeActive(ag, { title: "R2" });
      await R.setUserRole(admin, { userId: ag.id, role: "user" });
      await expect(A.hideListing(admin, l.id, { hidden: true, reason: "fraud review" })).resolves.toMatchObject({ changed: true });
      await R.setUserRole(admin, { userId: ag.id, role: "agent" });
      expect((await sql`select hidden_reason from listing where id = ${l.id}`)[0].hidden_reason).toBe("fraud review");
      // And unhiding is refused while the owner isn't an agent.
      await R.setUserRole(admin, { userId: ag.id, role: "user" });
      await expect(A.hideListing(admin, l.id, { hidden: false })).rejects.toMatchObject({ status: 409 });
    });

    it("the role write and the hide are one transaction: revoke and grant race a write without leaving a half state", async () => {
      const ag = await makeUser(sql, P, "racer", "agent");
      const l = await makeActive(ag, { title: "Race" });
      const results = await Promise.allSettled([
        ...Array.from({ length: 5 }, (_, i) => L.createListing(ag, facts({ title: `race ${i}` }))),
        R.setUserRole(admin, { userId: ag.id, role: "user" }),
      ]);
      expect(results.at(-1)).toMatchObject({ status: "fulfilled" });
      const [u] = await sql`select role from "user" where id = ${ag.id}`;
      expect(u.role).toBe("user");
      expect((await sql`select hidden_reason from listing where id = ${l.id}`)[0].hidden_reason).toBe("agent_revoked");
      // Every create either finished before the revoke or was refused after it.
      for (const r of results.slice(0, 5)) {
        if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 403 });
      }
      // Cover the photo helper being exercised outside publish too.
      await addPhoto(sql, l.id, 5);
    });
  });
});
