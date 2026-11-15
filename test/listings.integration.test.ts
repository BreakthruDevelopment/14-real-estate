/**
 * Listing, favorite and inquiry rules that are not about who may see what (that is access.integration.test.ts):
 * idempotent client op ids, optimistic locking, NUL bytes, publish checks, location checks, caps, cascades.
 * Runs against a real Postgres (TEST_DATABASE_URL).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestActor, ZIP_78704, addPhoto, cleanup, facts, makeUser, seedCentroid } from "./helpers";

const url = process.env.TEST_DATABASE_URL;
const P = "ls";

/** Latitude offset that moves a point `miles` due north. */
const northBy = (miles: number) => miles / 69.093;

describe.skipIf(!url)("listings, favorites and inquiries (Postgres)", () => {
  let sql: postgres.Sql;
  let agent: TestActor;
  let agent2: TestActor;
  let buyer: TestActor;
  let L: typeof import("@/lib/listings");
  let I: typeof import("@/lib/inquiries");
  let F: typeof import("@/lib/favorites");
  let errorInfo: typeof import("@/lib/http").errorInfo;

  const create = async (o: Record<string, unknown> = {}, who = agent) => (await L.createListing(who, facts(o))).listing;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup(sql, P);
    await seedCentroid(sql);
    agent = await makeUser(sql, P, "agent", "agent");
    agent2 = await makeUser(sql, P, "agent2", "agent");
    buyer = await makeUser(sql, P, "buyer", "user");
    L = await import("@/lib/listings");
    I = await import("@/lib/inquiries");
    F = await import("@/lib/favorites");
    errorInfo = (await import("@/lib/http")).errorInfo;
  });

  afterAll(async () => {
    await cleanup(sql, P);
    await sql.end();
  });

  describe("create", () => {
    it("makes a draft owned by the agent, located from the ZIP's centroid", async () => {
      const l = await create({ title: "First" });
      expect(l).toMatchObject({ status: "draft", version: 1, lat: ZIP_78704.lat, lng: ZIP_78704.lng, geoSource: "zip", features: ["fenced_yard", "home_office"] });
      expect(l.photos).toEqual([]);
      expect((await sql`select agent_id from listing where id = ${l.id}`)[0].agent_id).toBe(agent.id);
    });

    it("has no location when the ZIP's centroid isn't loaded", async () => {
      const l = await create({ zip: "99999" });
      expect(l).toMatchObject({ lat: null, lng: null, geoSource: null });
    });

    it("is idempotent per agent and client op id: a replay and parallel retries make one row", async () => {
      const clientOpId = crypto.randomUUID();
      const first = await L.createListing(agent, facts({ clientOpId, title: "Once" }));
      expect(first.created).toBe(true);
      const again = await L.createListing(agent, facts({ clientOpId, title: "Once" }));
      const parallel = await Promise.all([1, 2, 3, 4].map(() => L.createListing(agent, facts({ clientOpId, title: "Once" }))));
      expect(again).toMatchObject({ created: false });
      expect(again.listing.id).toBe(first.listing.id);
      expect(parallel.every((r) => r.listing.id === first.listing.id)).toBe(true);
      expect((await sql`select count(*)::int as n from listing where agent_id = ${agent.id} and client_op_id = ${clientOpId}`)[0].n).toBe(1);
      // Another agent with the same op id gets their own listing.
      const other = await L.createListing(agent2, facts({ clientOpId, title: "Once" }));
      expect(other.created).toBe(true);
      expect(other.listing.id).not.toBe(first.listing.id);
    });

    it("rejects NUL bytes with a 400 (validation), not a database 500", async () => {
      for (const o of [{ title: "bad\0title" }, { description: "bad\0" }, { agentNotes: "\0" }, { addressLine: "1\0 Main" }, { city: "Aus\0tin" }]) {
        const err = await L.createListing(agent, facts(o)).catch((e) => e);
        expect(errorInfo(err).status, JSON.stringify(o)).toBe(400);
      }
      const upd = await create();
      const err = await L.updateListing(agent, upd.id, { version: 1, title: "x\0y" }).catch((e) => e);
      expect(errorInfo(err).status).toBe(400);
    });

    it("validates facts at the boundary", async () => {
      const bad: Record<string, unknown>[] = [
        { title: "   " },
        { title: "x".repeat(101) },
        { priceUsd: 999 },
        { priceUsd: 100_000_001 },
        { priceUsd: 450000.5 },
        { beds: 21 },
        { baths: 2.25 },
        { sqft: 99 },
        { yearBuilt: 1799 },
        { yearBuilt: 2028 },
        { zip: "7870" },
        { state: "Texas" },
        { propertyType: "castle" },
        { features: ["moat"] },
        { features: Array.from({ length: 21 }, () => "pool") },
        { description: "x".repeat(3001) },
        { agentNotes: "x".repeat(1001) },
        { clientOpId: "nope" },
        { clientOpId: undefined },
      ];
      for (const o of bad) {
        const err = await L.createListing(agent, facts(o)).catch((e) => e);
        expect(errorInfo(err).status, JSON.stringify(o)).toBe(400);
      }
      // Lowercase state is normalised; duplicate features collapse.
      const ok = await create({ state: "tx", features: ["pool", "pool"] });
      expect(ok).toMatchObject({ state: "TX", features: ["pool"] });
    });

    it("stops at 50 listings per agent, and a replay still works at the cap", async () => {
      const capAgent = await makeUser(sql, P, "capagent", "agent");
      await sql`
        insert into listing (agent_id, title, property_type, price_usd, beds, baths, address_line, city, state, zip)
        select ${capAgent.id}, 'filler ' || g, 'house', 100000, 2, 1, '1 St', 'Austin', 'TX', '78704' from generate_series(1, 49) g`;
      const clientOpId = crypto.randomUUID();
      await L.createListing(capAgent, facts({ clientOpId })); // the 50th
      const over = await L.createListing(capAgent, facts()).catch((e) => e);
      expect(over).toMatchObject({ status: 409 });
      await expect(L.createListing(capAgent, facts({ clientOpId }))).resolves.toMatchObject({ created: false });
      // Deleting a draft frees a slot.
      const [{ id }] = await sql`select id from listing where agent_id = ${capAgent.id} limit 1`;
      await L.deleteListing(capAgent, id);
      await expect(L.createListing(capAgent, facts())).resolves.toMatchObject({ created: true });
    });

    it("stops at 5,000 listings app-wide, even when two different agents create at the same moment", async () => {
      const a = await makeUser(sql, P, "globalcap1", "agent");
      const b = await makeUser(sql, P, "globalcap2", "agent");
      const filler = await makeUser(sql, P, "globalfill", "agent");
      const [{ n }] = await sql`select count(*)::int as n from listing`;
      await sql`
        insert into listing (agent_id, title, property_type, price_usd, beds, baths, address_line, city, state, zip)
        select ${filler.id}, 'cap ' || g, 'house', 100000, 2, 1, '1 St', 'Austin', 'TX', '78704' from generate_series(1, ${4999 - n}::int) g`;
      const results = await Promise.allSettled([L.createListing(a, facts()), L.createListing(b, facts())]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
      expect((await sql`select count(*)::int as n from listing`)[0].n).toBe(5000);
      await sql`delete from listing where agent_id = ${filler.id}`;
    });

    it("limits writes to 300 an hour per agent (api_write)", async () => {
      const rate = await makeUser(sql, P, "rateagent", "agent");
      await sql`insert into rate_event (user_id, kind) select ${rate.id}, 'api_write' from generate_series(1, 300)`;
      await expect(L.createListing(rate, facts())).rejects.toMatchObject({ status: 429 });
    });
  });

  describe("update and optimistic locking", () => {
    it("changes only the fields sent and bumps the version", async () => {
      const l = await create({ title: "Before", sqft: 1200 });
      const next = await L.updateListing(agent, l.id, { version: l.version, title: "After", priceUsd: 500_000 });
      expect(next).toMatchObject({ title: "After", priceUsd: 500_000, sqft: 1200, beds: 3, version: 2 });
      // Nullable facts can be cleared.
      expect(await L.updateListing(agent, l.id, { version: 2, sqft: null })).toMatchObject({ sqft: null, version: 3 });
    });

    it("answers 409 for a stale version and changes nothing", async () => {
      const l = await create({ title: "Locked" });
      await L.updateListing(agent, l.id, { version: 1, title: "Winner" });
      const err = await L.updateListing(agent, l.id, { version: 1, title: "Loser" }).catch((e) => e);
      expect(errorInfo(err).status).toBe(409);
      expect((await sql`select title, version from listing where id = ${l.id}`)[0]).toMatchObject({ title: "Winner", version: 2 });
    });

    it("lets exactly one of several writers holding the same version win", async () => {
      const l = await create({ title: "Race" });
      const results = await Promise.allSettled([1, 2, 3, 4].map((n) => L.updateListing(agent, l.id, { version: 1, title: `writer ${n}` })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 409 });
      expect((await sql`select version from listing where id = ${l.id}`)[0].version).toBe(2);
    });

    it("refuses an empty change and a missing version (400)", async () => {
      const l = await create();
      expect(errorInfo(await L.updateListing(agent, l.id, { version: 1 }).catch((e) => e)).status).toBe(400);
      expect(errorInfo(await L.updateListing(agent, l.id, { title: "x" }).catch((e) => e)).status).toBe(400);
    });

    it("moving the ZIP resets the location to the new ZIP's centroid, or clears it", async () => {
      const l = await create();
      await sql`insert into zip_centroid (zip, lat, lng) values ('78701', 30.27, -97.74) on conflict (zip) do nothing`;
      expect(await L.updateListing(agent, l.id, { version: 1, zip: "78701" })).toMatchObject({ lat: 30.27, lng: -97.74, geoSource: "zip" });
      expect(await L.updateListing(agent, l.id, { version: 2, zip: "99998" })).toMatchObject({ lat: null, lng: null, geoSource: null });
    });
  });

  describe("status and publishing", () => {
    it("refuses to publish without a photo, then with a short description, then without a location", async () => {
      const l = await create();
      await expect(L.updateListing(agent, l.id, { version: 1, status: "active" })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("at least 1 photo") });
      await addPhoto(sql, l.id);
      const short = await L.updateListing(agent, l.id, { version: 1, description: "too short" });
      await expect(L.updateListing(agent, l.id, { version: short.version, status: "active" })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("200 characters") });
      expect((await sql`select status from listing where id = ${l.id}`)[0].status).toBe("draft");

      const nowhere = await create({ zip: "99997" });
      await addPhoto(sql, nowhere.id);
      await expect(L.updateListing(agent, nowhere.id, { version: 1, status: "active" })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("a location") });
    });

    it("publishes a complete listing, stamps published_at once, and keeps the checks on later edits", async () => {
      const l = await create();
      await addPhoto(sql, l.id);
      const live = await L.updateListing(agent, l.id, { version: 1, status: "active" });
      expect(live).toMatchObject({ status: "active", version: 2 });
      expect(live.publishedAt).toBeInstanceOf(Date);
      // An active listing can't be edited down below the publishing bar.
      await expect(L.updateListing(agent, l.id, { version: 2, description: "short" })).rejects.toMatchObject({ status: 422 });
      const pending = await L.updateListing(agent, l.id, { version: 2, status: "pending" });
      const back = await L.updateListing(agent, l.id, { version: pending.version, status: "active" });
      expect(back.publishedAt).toEqual(live.publishedAt);
    });

    it("follows the allowed transitions only", async () => {
      const l = await create();
      for (const to of ["pending", "sold", "withdrawn"] as const) {
        await expect(L.updateListing(agent, l.id, { version: 1, status: to }), `draft to ${to}`).rejects.toMatchObject({ status: 409 });
      }
      await addPhoto(sql, l.id);
      let cur = await L.updateListing(agent, l.id, { version: 1, status: "active" });
      cur = await L.updateListing(agent, l.id, { version: cur.version, status: "sold" });
      await expect(L.updateListing(agent, l.id, { version: cur.version, status: "pending" })).rejects.toMatchObject({ status: 409 });
      await expect(L.updateListing(agent, l.id, { version: cur.version, status: "draft" })).rejects.toMatchObject({ status: 409 });
      cur = await L.updateListing(agent, l.id, { version: cur.version, status: "active" });
      expect(cur.status).toBe("active");
    });
  });

  describe("location", () => {
    it("refuses a device location 6 mi from the ZIP centroid, accepts one 4 mi away", async () => {
      const l = await create();
      const far = { source: "device", version: 1, lat: ZIP_78704.lat + northBy(6), lng: ZIP_78704.lng, accuracyM: 10 };
      const err = await L.setListingLocation(agent, l.id, far).catch((e) => e);
      expect(err).toMatchObject({ status: 422 });
      expect(err.message).toMatch(/^6\.0 mi from ZIP 78704's centre: check the ZIP, or enter coordinates/);
      expect((await sql`select version, geo_source from listing where id = ${l.id}`)[0]).toMatchObject({ version: 1, geo_source: "zip" });
      const near = await L.setListingLocation(agent, l.id, { ...far, lat: ZIP_78704.lat + northBy(4) });
      expect(near).toMatchObject({ geoSource: "device", version: 2 });
    });

    it("refuses a device fix with accuracy worse than 200 m, and points outside the US", async () => {
      const l = await create();
      const base = { source: "device", version: 1, lat: ZIP_78704.lat, lng: ZIP_78704.lng };
      expect(errorInfo(await L.setListingLocation(agent, l.id, { ...base, accuracyM: 201 }).catch((e) => e)).status).toBe(400);
      expect(errorInfo(await L.setListingLocation(agent, l.id, { ...base, accuracyM: 5, lat: 10 }).catch((e) => e)).status).toBe(400);
      expect(errorInfo(await L.setListingLocation(agent, l.id, { ...base, accuracyM: 5, lng: 10 }).catch((e) => e)).status).toBe(400);
      expect(errorInfo(await L.setListingLocation(agent, l.id, { ...base, accuracyM: 5, lat: Number.NaN }).catch((e) => e)).status).toBe(400);
    });

    it("needs confirmFar for typed coordinates more than 5 mi away, and takes them with it", async () => {
      const l = await create();
      const typed = { source: "manual", version: 1, lat: ZIP_78704.lat + northBy(8), lng: ZIP_78704.lng };
      await expect(L.setListingLocation(agent, l.id, typed)).rejects.toMatchObject({ status: 422 });
      await expect(L.setListingLocation(agent, l.id, { ...typed, confirmFar: false })).rejects.toMatchObject({ status: 422 });
      expect(await L.setListingLocation(agent, l.id, { ...typed, confirmFar: true })).toMatchObject({ geoSource: "manual", version: 2 });
      // Close typed coordinates need no confirm, and `zip` goes back to the centroid.
      expect(await L.setListingLocation(agent, l.id, { source: "manual", version: 2, lat: ZIP_78704.lat + northBy(1), lng: ZIP_78704.lng })).toMatchObject({ geoSource: "manual" });
      expect(await L.setListingLocation(agent, l.id, { source: "zip", version: 3 })).toMatchObject({ geoSource: "zip", lat: ZIP_78704.lat });
    });

    it("has nothing to check a device location against when the ZIP has no centroid", async () => {
      const l = await create({ zip: "99996" });
      const at = { version: 1, lat: 30.2, lng: -97.7 };
      await expect(L.setListingLocation(agent, l.id, { ...at, source: "device", accuracyM: 5 })).rejects.toMatchObject({ status: 422 });
      await expect(L.setListingLocation(agent, l.id, { ...at, source: "manual" })).rejects.toMatchObject({ status: 422 });
      await expect(L.setListingLocation(agent, l.id, { source: "zip", version: 1 })).rejects.toMatchObject({ status: 409 });
      expect(await L.setListingLocation(agent, l.id, { ...at, source: "manual", confirmFar: true })).toMatchObject({ geoSource: "manual" });
    });

    it("answers 409 for a stale version", async () => {
      const l = await create();
      await L.updateListing(agent, l.id, { version: 1, title: "moved on" });
      await expect(L.setListingLocation(agent, l.id, { source: "zip", version: 1 })).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("delete", () => {
    it("deletes a draft; refuses an active listing; deletes a withdrawn one with its photos, blobs, favorites and inquiries", async () => {
      const d = await create();
      await L.deleteListing(agent, d.id);
      expect(await sql`select 1 from listing where id = ${d.id}`).toHaveLength(0);

      const l = await create({ title: "Cascade" });
      const photoId = await addPhoto(sql, l.id);
      const live = await L.updateListing(agent, l.id, { version: 1, status: "active" });
      await F.addFavorite(buyer, l.id);
      await I.createInquiry(buyer, { listingId: l.id, message: "hello", clientOpId: crypto.randomUUID() });
      await sql`insert into description_draft (listing_id, agent_id, output, checks, facts_hash, provider, demo) values (${l.id}, ${agent.id}, '{}', '{}', 'h', 'demo', true)`;
      await expect(L.deleteListing(agent, l.id)).rejects.toMatchObject({ status: 409 });
      expect(await sql`select 1 from listing where id = ${l.id}`).toHaveLength(1);

      await L.updateListing(agent, l.id, { version: live.version, status: "withdrawn" });
      await L.deleteListing(agent, l.id);
      const count = async (q: PromiseLike<readonly unknown[]>) => (await q).length;
      expect(await count(sql`select 1 from listing where id = ${l.id}`)).toBe(0);
      expect(await count(sql`select 1 from listing_photo where id = ${photoId}`)).toBe(0);
      expect(await count(sql`select 1 from photo_blob where photo_id = ${photoId}`)).toBe(0);
      expect(await count(sql`select 1 from favorite where listing_id = ${l.id}`)).toBe(0);
      expect(await count(sql`select 1 from inquiry where listing_id = ${l.id}`)).toBe(0);
      expect(await count(sql`select 1 from description_draft where listing_id = ${l.id}`)).toBe(0);
    });
  });

  describe("favorites and inquiries limits", () => {
    let live: { id: string };
    beforeAll(async () => {
      const l = await create({ title: "Limits" });
      await addPhoto(sql, l.id);
      await L.updateListing(agent, l.id, { version: 1, status: "active" });
      live = l;
    });

    it("stops at 200 favorites per buyer", async () => {
      const fan = await makeUser(sql, P, "fan", "user");
      const filler = await makeUser(sql, P, "filler", "agent");
      await sql`
        insert into listing (agent_id, title, property_type, status, price_usd, beds, baths, address_line, city, state, zip)
        select ${filler.id}, 'fav ' || g, 'house', 'active', 100000, 2, 1, '1 St', 'Austin', 'TX', '78704' from generate_series(1, 200) g`;
      await sql`insert into favorite (user_id, listing_id) select ${fan.id}, id from listing where agent_id = ${filler.id}`;
      await expect(F.addFavorite(fan, live.id)).rejects.toMatchObject({ status: 409 });
      await expect(F.listFavorites(fan)).resolves.toHaveLength(200);
    });

    it("removing a favorite costs a write only when something is removed, and stops at the hourly limit", async () => {
      const b = await makeUser(sql, P, "favrate", "user");
      await F.addFavorite(b, live.id);
      await sql`insert into rate_event (user_id, kind) select ${b.id}, 'api_write' from generate_series(1, 299)`; // add used 1 of 300
      await expect(F.removeFavorite(b, live.id)).rejects.toMatchObject({ status: 429 });
      expect(await F.listFavorites(b)).toHaveLength(1); // the delete was rolled back
      await sql`delete from rate_event where user_id = ${b.id}`;
      await expect(F.removeFavorite(b, live.id)).resolves.toEqual({ removed: true });
      await expect(F.removeFavorite(b, live.id)).resolves.toEqual({ removed: false });
    });

    it("an inquiry is idempotent per buyer and client op id, and a buyer has one open inquiry per listing", async () => {
      const b = await makeUser(sql, P, "inq1", "user");
      const clientOpId = crypto.randomUUID();
      const first = await I.createInquiry(b, { listingId: live.id, message: "once", clientOpId });
      const parallel = await Promise.all([1, 2, 3].map(() => I.createInquiry(b, { listingId: live.id, message: "once", clientOpId })));
      expect(first.created).toBe(true);
      expect(parallel.every((r) => !r.created && r.inquiry.id === first.inquiry.id)).toBe(true);
      expect((await sql`select count(*)::int as n from inquiry where buyer_id = ${b.id}`)[0].n).toBe(1);
      // A second, different request while the first is open is a 409; after it is closed a new one is fine.
      await expect(I.createInquiry(b, { listingId: live.id, message: "again", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
      await I.updateInquiryStatus(agent, first.inquiry.id, { status: "closed" });
      await expect(I.createInquiry(b, { listingId: live.id, message: "again", clientOpId: crypto.randomUUID() })).resolves.toMatchObject({ created: true });
      // Reopening the closed one now collides with the new open one.
      await expect(I.updateInquiryStatus(agent, first.inquiry.id, { status: "open" })).rejects.toMatchObject({ status: 409 });
      // Reusing an op id for another listing is refused.
      const other = await create({ title: "Other" });
      await addPhoto(sql, other.id);
      await L.updateListing(agent, other.id, { version: 1, status: "active" });
      await expect(I.createInquiry(b, { listingId: other.id, message: "x", clientOpId })).rejects.toMatchObject({ status: 409 });
    });

    it("limits an agent's inquiry status changes to the 300 writes an hour too", async () => {
      const b = await makeUser(sql, P, "inq5", "user");
      const { inquiry } = await I.createInquiry(b, { listingId: live.id, message: "hello", clientOpId: crypto.randomUUID() });
      await sql`insert into rate_event (user_id, kind) select ${agent.id}, 'api_write' from generate_series(1, 300)`;
      await expect(I.updateInquiryStatus(agent, inquiry.id, { status: "contacted" })).rejects.toMatchObject({ status: 429 });
      expect((await sql`select status from inquiry where id = ${inquiry.id}`)[0].status).toBe("open");
      // Setting the status it already has is not a write.
      await expect(I.updateInquiryStatus(agent, inquiry.id, { status: "open" })).resolves.toMatchObject({ status: "open" });
      await sql`delete from rate_event where user_id = ${agent.id}`;
    });

    it("validates the message: required, at most 1,000 characters, no NUL byte (400)", async () => {
      const b = await makeUser(sql, P, "inq2", "user");
      for (const message of ["", "   ", "x".repeat(1001), "bad\0"]) {
        const err = await I.createInquiry(b, { listingId: live.id, message, clientOpId: crypto.randomUUID() }).catch((e) => e);
        expect(errorInfo(err).status, JSON.stringify(message.slice(0, 5))).toBe(400);
      }
      expect(errorInfo(await I.createInquiry(b, { listingId: live.id, message: "ok", clientOpId: "nope" }).catch((e) => e)).status).toBe(400);
    });

    it("allows 5 inquiries an hour and 20 a day", async () => {
      const hour = await makeUser(sql, P, "inq3", "user");
      const filler = await makeUser(sql, P, "filler2", "agent");
      await sql`
        insert into listing (agent_id, title, property_type, status, price_usd, beds, baths, address_line, city, state, zip)
        select ${filler.id}, 'inq ' || g, 'house', 'active', 100000, 2, 1, '1 St', 'Austin', 'TX', '78704' from generate_series(1, 7) g`;
      const ids = (await sql`select id from listing where agent_id = ${filler.id}`).map((r) => r.id as string);
      for (const id of ids.slice(0, 5)) await I.createInquiry(hour, { listingId: id, message: "hi", clientOpId: crypto.randomUUID() });
      await expect(I.createInquiry(hour, { listingId: ids[5], message: "hi", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 429 });

      const day = await makeUser(sql, P, "inq4", "user");
      await sql`
        insert into inquiry (listing_id, buyer_id, message, status, client_op_id)
        select ${ids[0]}, ${day.id}, 'old', 'closed', gen_random_uuid() from generate_series(1, 20)`;
      await expect(I.createInquiry(day, { listingId: ids[1], message: "hi", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 429 });
      // Yesterday's don't count.
      await sql`update inquiry set created_at = now() - interval '2 days' where buyer_id = ${day.id}`;
      await expect(I.createInquiry(day, { listingId: ids[1], message: "hi", clientOpId: crypto.randomUUID() })).resolves.toMatchObject({ created: true });
    });
  });

  describe("schema constraints (the second layer)", () => {
    it("rejects bad rows even when the data layer is bypassed", async () => {
      const bad = (cols: string) =>
        sql.unsafe(`insert into listing (agent_id, title, property_type, price_usd, beds, baths, address_line, city, state, zip ${cols.split("|")[0]}) values ('${agent.id}', 't', 'house', 100000, 2, 1, '1 St', 'Austin', 'TX', '78704' ${cols.split("|")[1] ?? ""})`);
      await expect(bad(", lat|, 30")).rejects.toMatchObject({ code: "23514" }); // lat without lng and geo_source
      await expect(bad(", hidden_at|, now()")).rejects.toMatchObject({ code: "23514" }); // hidden without a reason
      await expect(bad(", status|, 'archived'")).rejects.toMatchObject({ code: "23514" });
      await expect(sql`insert into photo_blob (photo_id, variant, bytes, sha256, width, height) select id, 'lg', ${Buffer.alloc(409_601)}, 'x', 1, 1 from listing_photo limit 1`).rejects.toMatchObject({ code: "23514" });
    });
  });
});
