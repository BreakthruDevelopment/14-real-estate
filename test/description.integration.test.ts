/**
 * The description writer and the fair-housing save check against a real Postgres (TEST_DATABASE_URL):
 * a flagged save is refused on every write path, "family room" and "walk-in closet" are accepted, the demo fixture passes
 * the photo check against a photo inserted with DEMO_LIVING_ROOM_PHOTO_ID, ownership, limits, refunds, and that the
 * request that leaves for the model carries no address or personal data.
 */
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { demoFixtures } from "@/lib/ai/demo";
import { DEMO_BUNGALOW_LISTING_ID, DEMO_LIVING_ROOM_PHOTO_ID } from "@/lib/demo/ids";
import { type TestActor, addPhoto, cleanup, facts, makeUser, seedCentroid } from "./helpers";

const url = process.env.TEST_DATABASE_URL;
const P = "dd";

describe.skipIf(!url)("description writer and fair-housing save check (Postgres)", () => {
  let sql: postgres.Sql;
  let agent: TestActor;
  let agent2: TestActor;
  let buyer: TestActor;
  let L: typeof import("@/lib/listings");
  let D: typeof import("@/lib/description-draft");
  let errorInfo: typeof import("@/lib/http").errorInfo;
  let resetEnvCache: typeof import("@/lib/env").resetEnvCache;
  const webp = readFileSync("test/fixtures/images/photo.webp");

  /** A fresh request id per call, as a client would mint one per intent. */
  const draft = (who: TestActor | null, id: string, input: unknown = {}, op: string = crypto.randomUUID()) => D.createDescriptionDraft(who, id, input, op);
  const create = async (o: Record<string, unknown> = {}, who = agent) => (await L.createListing(who, facts(o))).listing;
  const status = async (p: Promise<unknown>) => {
    try {
      await p;
      return 200;
    } catch (e) {
      return errorInfo(e).status;
    }
  };
  const rejection = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return errorInfo(e);
    }
    throw new Error("expected a rejection");
  };

  /** The demo listing and its living-room photo, with the exact ids 14.10 will seed. */
  async function seedDemoBungalow() {
    await sql`delete from listing where id = ${DEMO_BUNGALOW_LISTING_ID}`;
    await sql`insert into listing (id, agent_id, title, property_type, price_usd, beds, baths, sqft, year_built, features, address_line, city, state, zip, description, agent_notes, client_op_id)
      values (${DEMO_BUNGALOW_LISTING_ID}, ${agent.id}, 'Craftsman bungalow near Zilker', 'house', 450000, 3, 2, 1640, 1938, ${["fenced_yard", "home_office"]}, '123 Main St', 'Austin', 'TX', '78704', '', '', ${crypto.randomUUID()})`;
    await sql`insert into listing_photo (id, listing_id, position, width, height, bytes_total, sha256)
      values (${DEMO_LIVING_ROOM_PHOTO_ID}, ${DEMO_BUNGALOW_LISTING_ID}, 0, 1280, 960, ${webp.length}, ${"cd".repeat(32)})`;
    for (const variant of ["lg", "md", "sm"]) {
      await sql`insert into photo_blob (photo_id, variant, bytes, sha256, width, height) values (${DEMO_LIVING_ROOM_PHOTO_ID}, ${variant}, ${webp}, 'x', 1, 1)`;
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.AI_PROVIDER = "demo";
    process.env.LOG_LEVEL = "error";
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup(sql, P);
    await sql`delete from listing where id = ${DEMO_BUNGALOW_LISTING_ID}`;
    await seedCentroid(sql);
    agent = await makeUser(sql, P, "agent", "agent");
    agent2 = await makeUser(sql, P, "agent2", "agent");
    buyer = await makeUser(sql, P, "buyer", "user");
    L = await import("@/lib/listings");
    D = await import("@/lib/description-draft");
    errorInfo = (await import("@/lib/http")).errorInfo;
    resetEnvCache = (await import("@/lib/env")).resetEnvCache;
    resetEnvCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.env.AI_PROVIDER = "demo";
    resetEnvCache();
    await sql`delete from rate_event where user_id like ${P + "-%"}`;
    await sql`delete from description_draft where agent_id like ${P + "-%"}`;
    await sql`delete from daily_usage where kind = 'ai'`;
  });

  afterAll(async () => {
    await cleanup(sql, P);
    await sql.end();
  });

  describe("a flagged save is refused (D5), a clean one is not", () => {
    it("refuses a flagged description on PATCH with a 400 naming the phrase, and changes nothing", async () => {
      const l = await create();
      const e = await rejection(L.updateListing(agent, l.id, { version: l.version, description: `${"A".repeat(200)} Sorry, no kids.` }));
      expect(e.status).toBe(400);
      expect(e.body.error).toContain('"no kids"');
      expect(e.body.error).toContain("familial status");
      const after = await L.getMyListing(agent, l.id);
      expect(after.version).toBe(l.version);
      expect(after.description).toBe("A".repeat(250));
    });

    it("refuses a flagged title, and a flagged description on create", async () => {
      const l = await create();
      expect(await status(L.updateListing(agent, l.id, { version: l.version, title: "Adults only bungalow" }))).toBe(400);
      expect(await status(L.createListing(agent, facts({ description: "Perfect for young families." })))).toBe(400);
      expect(await status(L.createListing(agent, facts({ title: "No children please" })))).toBe(400);
    });

    it("refuses on a request that also changes something else (status), without writing the rest", async () => {
      const l = await create();
      await addPhoto(sql, l.id);
      const e = await status(L.updateListing(agent, l.id, { version: l.version, status: "active", description: `${"A".repeat(200)} adults only` }));
      expect(e).toBe(400);
      expect((await L.getMyListing(agent, l.id)).status).toBe("draft");
    });

    it("accepts 'family room' and 'walk-in closet' (and the other allow-listed phrases)", async () => {
      const l = await create();
      const description = `${"A".repeat(120)} A bright family room, a walk-in closet, a master bedroom, a great view, walking distance to shops and jogging trails.`;
      const saved = await L.updateListing(agent, l.id, { version: l.version, description });
      expect(saved.description).toBe(description);
      expect(saved.version).toBe(l.version + 1);
      expect(await status(L.createListing(agent, facts({ description })))).toBe(200);
    });

    it("refuses to publish a listing whose stored description is flagged, however it got there", async () => {
      const l = await create();
      await addPhoto(sql, l.id);
      await sql`update listing set description = ${"A".repeat(200) + " no kids"} where id = ${l.id}`;
      const e = await rejection(L.updateListing(agent, l.id, { version: l.version, status: "active" }));
      expect(e.status).toBe(400);
      expect(e.body.error).toContain('"no kids"');
      // Fixing the text lets it through.
      const fixed = await L.updateListing(agent, l.id, { version: l.version, description: "A".repeat(250), status: "active" });
      expect(fixed.status).toBe("active");
    });
  });

  describe("a stored title is screened on publish too", () => {
    it("refuses to publish a listing whose stored title is flagged, naming the title, and lets a fixed one through", async () => {
      const l = await create();
      await addPhoto(sql, l.id);
      await sql`update listing set title = 'Quiet bungalow, adults only' where id = ${l.id}`;
      const e = await rejection(L.updateListing(agent, l.id, { version: l.version, status: "active" }));
      expect(e.status).toBe(400);
      expect(e.body.error).toContain("title");
      expect(e.body.error).toContain('"adults only"');
      expect((await L.getMyListing(agent, l.id)).status).toBe("draft");
      const ok = await L.updateListing(agent, l.id, { version: l.version, title: "Quiet bungalow", status: "active" });
      expect(ok.status).toBe("active");
    });
  });

  describe("the demo fixture against the seeded bungalow", () => {
    it("passes every check, photo included, for a photo inserted with DEMO_LIVING_ROOM_PHOTO_ID", async () => {
      await seedDemoBungalow();
      const r = await draft(agent, DEMO_BUNGALOW_LISTING_ID, {});
      expect(r.demo).toBe(true);
      expect(r.draft.flags).toEqual([]);
      expect(r.draft.dropped).toEqual({ highlights: [], photoSuggestions: [] });
      expect(r.draft.photoSuggestions).toEqual([{ feature: "Built-in shelving", photoId: DEMO_LIVING_ROOM_PHOTO_ID }]);
      expect(r.blocked).toBe(false);
      const rows = await sql`select agent_id, demo, output, checks from description_draft where listing_id = ${DEMO_BUNGALOW_LISTING_ID}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].agent_id).toBe(agent.id);
      expect(rows[0].demo).toBe(true);
    });

    it("and an agent's saved draft text goes through the same save check", async () => {
      await seedDemoBungalow();
      const r = await draft(agent, DEMO_BUNGALOW_LISTING_ID, {});
      const l = await L.getMyListing(agent, DEMO_BUNGALOW_LISTING_ID);
      expect((await L.updateListing(agent, l.id, { version: l.version, description: r.draft.description })).description).toBe(r.draft.description);
    });

    it("is flagged honestly against a listing whose facts differ, and its photo suggestion is dropped", async () => {
      const l = await create({ beds: 5, yearBuilt: 1999, features: [] });
      await addPhoto(sql, l.id);
      const r = await draft(agent, l.id, {});
      expect(r.draft.flags.map((f) => f.code)).toContain("unverified_number");
      expect(r.draft.dropped.highlights.map((h) => h.text)).toEqual(["Fenced yard"]);
      expect(r.draft.photoSuggestions).toEqual([]);
      expect(r.draft.dropped.photoSuggestions).toHaveLength(1);
    });
  });

  describe("who may ask", () => {
    it("404 for another agent's listing and for a missing id alike, 403 for a buyer", async () => {
      const l = await create();
      expect(await status(draft(agent2, l.id, {}))).toBe(404);
      expect(await status(draft(agent, crypto.randomUUID(), {}))).toBe(404);
      expect(await status(draft(agent, "not-a-uuid", {}))).toBe(404);
      expect(await status(draft(buyer, l.id, {}))).toBe(403);
      expect(await status(draft(null, l.id, {}))).toBe(401);
    });

    it("refuses photo ids that belong to another listing, even another agent's", async () => {
      const mine = await create();
      const theirs = await create({}, agent2);
      const foreignPhoto = await addPhoto(sql, theirs.id);
      expect(await status(draft(agent, mine.id, { photoIds: [foreignPhoto] }))).toBe(400);
      expect(await status(draft(agent, mine.id, { photoIds: ["nope"] }))).toBe(400);
      expect(await status(draft(agent, mine.id, { tone: "shouty" }))).toBe(400);
      expect(await status(draft(agent, mine.id, { photoIds: Array.from({ length: 4 }, () => crypto.randomUUID()) }))).toBe(400);
    });
  });

  describe("limits", () => {
    it("10 drafts per agent per hour (429), and the refused one is not recorded", async () => {
      const l = await create();
      for (let i = 0; i < 10; i++) await sql`insert into rate_event (user_id, kind) values (${agent.id}, 'ai')`;
      expect(await status(draft(agent, l.id, {}))).toBe(429);
      expect((await sql`select count(*)::int n from description_draft where listing_id = ${l.id}`)[0].n).toBe(0);
    });

    it("5 drafts per listing per day (429); older drafts do not count, and only the newest 5 are kept", async () => {
      const l = await create();
      for (let i = 0; i < 5; i++) {
        await draft(agent, l.id, {});
        await sql`delete from rate_event where user_id = ${agent.id}`;
      }
      expect(await status(draft(agent, l.id, {}))).toBe(429);
      await sql`update description_draft set created_at = now() - interval '2 days' where listing_id = ${l.id}`;
      expect(await status(draft(agent, l.id, {}))).toBe(200);
      expect((await sql`select count(*)::int n from description_draft where listing_id = ${l.id}`)[0].n).toBe(5);
    });

    it("AI_DAILY_CAP is app-wide (429)", async () => {
      vi.stubEnv("AI_DAILY_CAP", "1");
      resetEnvCache();
      const a = await create();
      const b = await create({}, agent2);
      expect(await status(draft(agent, a.id, {}))).toBe(200);
      expect(await status(draft(agent2, b.id, {}))).toBe(429);
    });
  });

  describe("retries are idempotent and the per-listing cap can't be overshot (#23)", () => {
    /** A live-path model stub that takes `delayMs` to answer and counts how many times it was called. */
    function slowModel(delayMs: number, fail = false) {
      const state = { calls: 0 };
      vi.stubGlobal("fetch", async () => {
        state.calls++;
        await new Promise((r) => setTimeout(r, delayMs));
        if (fail) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(demoFixtures["listing-description"]) }] } }] }));
      });
      vi.stubEnv("AI_PROVIDER", "gemini");
      vi.stubEnv("GEMINI_API_KEY", "test-key-not-real");
      vi.stubEnv("AI_FALLBACK_TO_DEMO", "false");
      resetEnvCache();
      return state;
    }
    const rows = async (listingId: string) => (await sql`select count(*)::int n from description_draft where listing_id = ${listingId}`)[0].n as number;
    const used = async () => ({
      hourly: (await sql`select count(*)::int n from rate_event where user_id = ${agent.id} and kind = 'ai'`)[0].n as number,
      daily: (await sql`select coalesce(sum(count), 0)::int n from daily_usage where kind = 'ai' and day = (now() at time zone 'utc')::date`)[0].n as number,
    });

    it("the same x-client-op, sent again after the first answer, returns the FIRST draft: one model call, one row, one allowance", async () => {
      const model = slowModel(0);
      const l = await create();
      const op = crypto.randomUUID();
      const first = await draft(agent, l.id, {}, op);
      const again = await draft(agent, l.id, {}, op);
      expect(first.replayed).toBe(false);
      expect(again.replayed).toBe(true);
      expect(again.id).toBe(first.id);
      expect(again.draft).toEqual(first.draft);
      expect(again.blocked).toBe(first.blocked);
      expect(model.calls).toBe(1);
      expect(await rows(l.id)).toBe(1);
      expect(await used()).toEqual({ hourly: 1, daily: 1 });
      // A new intent is a new draft.
      expect((await draft(agent, l.id, {}, crypto.randomUUID())).replayed).toBe(false);
      expect(model.calls).toBe(2);
    });

    it("the same x-client-op sent while the first is still running waits and gets the first answer: one model call, one row", async () => {
      const model = slowModel(500);
      const l = await create();
      const op = crypto.randomUUID();
      const results = await Promise.all([draft(agent, l.id, {}, op), draft(agent, l.id, {}, op), draft(agent, l.id, {}, op), draft(agent, l.id, {}, op)]);
      expect(model.calls).toBe(1);
      expect(await rows(l.id)).toBe(1);
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await used()).toEqual({ hourly: 1, daily: 1 });
    });

    it("a burst of different requests for one listing can't take it above 5 drafts a day, or make more than 5 model calls", async () => {
      const model = slowModel(400);
      const l = await create();
      const outcomes = await Promise.all(Array.from({ length: 12 }, () => status(draft(agent, l.id, {}, crypto.randomUUID()))));
      expect(outcomes.filter((s) => s === 200)).toHaveLength(5);
      expect(outcomes.filter((s) => s === 429)).toHaveLength(7);
      expect(model.calls).toBe(5);
      expect(await rows(l.id)).toBe(5);
      expect(await used()).toEqual({ hourly: 5, daily: 5 });
    });

    it("the app-wide AI_DAILY_CAP also holds under a burst across agents", async () => {
      vi.stubEnv("AI_DAILY_CAP", "3");
      const model = slowModel(300);
      vi.stubEnv("AI_DAILY_CAP", "3");
      resetEnvCache();
      const a = await create();
      const b = await create({}, agent2);
      const outcomes = await Promise.all([a.id, a.id, a.id, b.id, b.id, b.id].map((id, i) => status(draft(i < 3 ? agent : agent2, id, {}, crypto.randomUUID()))));
      expect(outcomes.filter((s) => s === 200)).toHaveLength(3);
      expect(model.calls).toBe(3);
    });

    it("a failed model call frees the slot, and the same x-client-op can then be retried for real", async () => {
      const l = await create();
      const op = crypto.randomUUID();
      const failing = slowModel(0, true);
      expect(await status(draft(agent, l.id, {}, op))).toBeGreaterThanOrEqual(500);
      expect(failing.calls).toBeGreaterThan(0);
      expect(await rows(l.id)).toBe(0);
      expect(await used()).toEqual({ hourly: 0, daily: 0 });
      const working = slowModel(0);
      const r = await draft(agent, l.id, {}, op);
      expect(r.replayed).toBe(false);
      expect(working.calls).toBe(1);
      expect(await rows(l.id)).toBe(1);
    });

    it("a slot abandoned by a dead request (pending for over a minute) is taken over by a retry; a fresh pending one is waited on", async () => {
      const l = await create();
      const stale = crypto.randomUUID();
      await sql`insert into description_draft (listing_id, agent_id, output, checks, facts_hash, provider, client_op_id, status, created_at)
        values (${l.id}, ${agent.id}, '{}', '{}', '', '', ${stale}, 'pending', now() - interval '2 minutes')`;
      const model = slowModel(0);
      const r = await draft(agent, l.id, {}, stale);
      expect(r.replayed).toBe(false);
      expect(model.calls).toBe(1);
      expect(await rows(l.id)).toBe(1);
      expect((await sql`select status from description_draft where listing_id = ${l.id}`)[0].status).toBe("done");
    });

    it("requires a UUID op id, and the database enforces one draft per (listing, op id)", async () => {
      const l = await create();
      expect(await status(draft(agent, l.id, {}, "not-a-uuid"))).toBe(400);
      const op = crypto.randomUUID();
      const ins = () => sql`insert into description_draft (listing_id, agent_id, output, checks, facts_hash, provider, client_op_id) values (${l.id}, ${agent.id}, '{}', '{}', 'h', 'p', ${op})`;
      await ins();
      await expect(ins()).rejects.toThrow(/description_draft_client_op_uidx/);
    });
  });

  describe("what leaves for the model (live provider path, fetch stubbed)", () => {
    function stubGemini(respond: () => Response) {
      const bodies: string[] = [];
      vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ""));
        return respond();
      });
      vi.stubEnv("AI_PROVIDER", "gemini");
      vi.stubEnv("GEMINI_API_KEY", "test-key-not-real");
      vi.stubEnv("AI_FALLBACK_TO_DEMO", "false");
      resetEnvCache();
      return bodies;
    }

    it("carries no street address, agent id, title or contact detail, sends at most 3 md photos, and a failure refunds the allowance", async () => {
      const l = await create({
        title: "Sentinel Title Nobody Should See",
        addressLine: "4417 Quillback Ridge Dr",
        agentNotes: "Call (512) 555-0142 or pat@brokerage.example about 4417 Quillback Ridge Dr. New roof 2021.",
      });
      const photos = [await addPhoto(sql, l.id, 0), await addPhoto(sql, l.id, 1), await addPhoto(sql, l.id, 2), await addPhoto(sql, l.id, 3)];
      const bodies = stubGemini(() => new Response("boom", { status: 500 }));

      expect(await status(draft(agent, l.id, { photoIds: photos }))).toBe(400); // 4 photos
      expect(await status(draft(agent, l.id, { photoIds: photos.slice(0, 3), tone: "concise" }))).toBeGreaterThanOrEqual(500);
      expect(bodies.length).toBeGreaterThan(0);
      const sent = bodies[0];
      for (const secret of ["Quillback", "4417", agent.id, "Sentinel Title", l.id, "555-0142", "brokerage.example", "123 Main"]) {
        expect(sent, secret).not.toContain(secret);
      }
      expect(sent).toContain("New roof 2021");
      expect(sent.match(/inlineData/g)).toHaveLength(3);
      for (const p of photos.slice(0, 3)) expect(sent).toContain(p);
      expect(sent).not.toContain(photos[3]);

      // The model call failed: nothing was recorded, and neither allowance stays used.
      expect((await sql`select count(*)::int n from description_draft where listing_id = ${l.id}`)[0].n).toBe(0);
      expect((await sql`select count(*)::int n from rate_event where user_id = ${agent.id} and kind = 'ai'`)[0].n).toBe(0);
      expect((await sql`select coalesce(sum(count), 0)::int n from daily_usage where kind = 'ai' and day = (now() at time zone 'utc')::date`)[0].n).toBe(0);
    });

    it("defaults to the cover photo only", async () => {
      const l = await create();
      await addPhoto(sql, l.id, 0);
      await addPhoto(sql, l.id, 1);
      const bodies = stubGemini(() => new Response("boom", { status: 500 }));
      await status(draft(agent, l.id, {}));
      expect(bodies[0].match(/inlineData/g)).toHaveLength(1);
    });
  });
});
