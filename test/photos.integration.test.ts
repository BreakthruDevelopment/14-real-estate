/**
 * The photo upload boundary and the `/img` route (spec 14, "Image pipeline", "Rate limits and caps", "Threat model"),
 * against a real Postgres (TEST_DATABASE_URL), through the route handlers themselves so status codes and headers are
 * what a client sees. Only the session is stubbed: `current` is who is "signed in".
 *
 * Every rule from issue 14.4's "Done when" has a test here, and the two that are easiest to fake are proven rather
 * than asserted: the 304 never reading `bytes` (a database role that is not allowed to read the column answers it),
 * and a stored SVG never leaving as `image/svg+xml`.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { ensureLargeFixtures, readFixture } from "./fixtures/images/make";
import { type TestActor, ZIP_78704, cleanup, facts, makeUser, seedCentroid } from "./helpers";

const url = process.env.TEST_DATABASE_URL;
const P = "ph";

// --- who is signed in -------------------------------------------------------------------------------------------
const session = vi.hoisted(() => ({ current: null as null | { id: string; role: "user" | "agent" | "admin" } }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: async () => session.current,
  requireUser: async () => {
    if (!session.current) throw new UnauthorizedError();
    return session.current;
  },
  requireRole: async (role: string) => {
    if (!session.current) throw new UnauthorizedError();
    if (role !== "user" && session.current.role !== role) throw new ForbiddenError();
    return session.current;
  },
}));

// --- the image module, wrapped so a test can make it answer with a given refusal ---------------------------------
const proc = vi.hoisted(() => ({ override: null as null | (() => Promise<never>), calls: 0 }));
vi.mock("@/lib/images/process", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/images/process")>();
  return {
    ...real,
    processImage: (input: Parameters<typeof real.processImage>[0]) => {
      proc.calls += 1;
      return proc.override ? proc.override() : real.processImage(input);
    },
  };
});

const ORIGIN = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const BASE = ORIGIN;
const uuid = () => crypto.randomUUID();
const JPEG = "image/jpeg";
const PNG = "image/png";

describe.skipIf(!url)("photo upload and serving (Postgres)", () => {
  let sql: postgres.Sql;
  let agent: TestActor;
  let agent2: TestActor;
  let buyer: TestActor;
  let admin: TestActor;
  let L: typeof import("@/lib/listings");
  let Ph: typeof import("@/lib/photos");
  let Upload: typeof import("@/app/api/listings/[id]/photos/route");
  let One: typeof import("@/app/api/listings/[id]/photos/[photoId]/route");
  let Img: typeof import("@/app/img/[photoId]/[variant]/route");
  let ListingApi: typeof import("@/app/api/listings/[id]/route");
  let ipLimit: typeof import("@/lib/ip-limit");
  let ImageModule: typeof import("@/lib/images/process");
  let A: typeof import("@/lib/admin");
  let envMod: typeof import("@/lib/env");

  let small: Buffer; // 320 x 240 JPEG with GPS EXIF: quick to process
  let png: Buffer;
  let ip = 0;
  const nextIp = () => `198.51.100.${++ip % 250}`;

  const as = (who: TestActor | null) => {
    session.current = who;
  };
  const newListing = async (who = agent, o: Record<string, unknown> = {}) => (await L.createListing(who, facts(o))).listing;

  const upload = (listingId: string, body: Uint8Array | null, opts: { type?: string | null; op?: string | null; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": nextIp(), ...opts.headers };
    if (opts.type !== null) headers["content-type"] = opts.type ?? JPEG;
    if (opts.op !== null) headers["x-client-op"] = opts.op ?? uuid();
    return Upload.POST(new Request(`${BASE}/api/listings/${listingId}/photos`, { method: "POST", headers, body: body as BodyInit | null }), {
      params: Promise.resolve({ id: listingId }),
    });
  };
  const ok = async (res: Response) => {
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    return (await res.json()).photo as { id: string; position: number; v: string };
  };
  const uploadOk = async (listingId: string, body = small, type = JPEG) => ok(await upload(listingId, body, { type }));

  const get = (photoId: string, variant = "md", headers: Record<string, string> = {}) =>
    Img.GET(new Request(`${BASE}/img/${photoId}/${variant}`, { headers: { "x-forwarded-for": nextIp(), ...headers } }), {
      params: Promise.resolve({ photoId, variant }),
    });

  const patch = (listingId: string, photoId: string, body: unknown) =>
    One.PATCH(new Request(`${BASE}/x`, { method: "PATCH", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ id: listingId, photoId }),
    });
  const del = (listingId: string, photoId: string) =>
    One.DELETE(new Request(`${BASE}/x`, { method: "DELETE", headers: { origin: ORIGIN } }), { params: Promise.resolve({ id: listingId, photoId }) });

  const rows = async (q: Promise<postgres.RowList<postgres.Row[]>>) => (await q)[0].n as number;
  const photoCount = (listingId: string) => rows(sql`select count(*)::int as n from listing_photo where listing_id = ${listingId}`);
  const blobCount = (listingId: string) =>
    rows(sql`select count(*)::int as n from photo_blob where photo_id in (select id from listing_photo where listing_id = ${listingId})`);
  const uploadsUsed = (who: TestActor) => rows(sql`select count(*)::int as n from rate_event where user_id = ${who.id} and kind = 'photo_upload'`);

  /** Make a listing public: a real photo, then publish through the data layer. */
  const publishListing = async (who = agent, o: Record<string, unknown> = {}) => {
    const l = await newListing(who, o);
    as(who);
    const photo = await uploadOk(l.id);
    await L.updateListing(who, l.id, { version: l.version, status: "active" });
    return { listing: l, photo };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL ??= "http://localhost:3000";
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup(sql, P);
    await seedCentroid(sql, ZIP_78704);
    agent = await makeUser(sql, P, "agent", "agent");
    agent2 = await makeUser(sql, P, "agent2", "agent");
    buyer = await makeUser(sql, P, "buyer", "user");
    admin = await makeUser(sql, P, "admin", "admin");
    L = await import("@/lib/listings");
    Ph = await import("@/lib/photos");
    Upload = await import("@/app/api/listings/[id]/photos/route");
    One = await import("@/app/api/listings/[id]/photos/[photoId]/route");
    Img = await import("@/app/img/[photoId]/[variant]/route");
    ListingApi = await import("@/app/api/listings/[id]/route");
    ipLimit = await import("@/lib/ip-limit");
    ImageModule = await import("@/lib/images/process");
    A = await import("@/lib/admin");
    envMod = await import("@/lib/env");
    await ensureLargeFixtures(); // the worst-case inputs the image tests use too, written once and cached on disk
    small = await readFixture("small-320x240.jpg");
    png = await readFixture("photo.png");
  }, 120_000);

  beforeEach(async () => {
    // Each test starts with a clean hourly allowance: the suite uploads far more than 60 photos.
    await sql`delete from rate_event where user_id like ${P + "-%"}`;
    ipLimit.resetPublicLimiter();
    proc.override = null;
    proc.calls = 0;
    as(agent);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PHOTO_STORE_CAP_MB;
    envMod.resetEnvCache();
  });

  afterAll(async () => {
    await cleanup(sql, P);
    await sql.end();
  });

  // =================================================================================================================
  describe("upload: who and what", () => {
    it("an agent's upload becomes one photo with three WebP variants and no camera GPS", async () => {
      const l = await newListing();
      const res = await upload(l.id, small);
      expect(res.status).toBe(201);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const photo = (await res.json()).photo;
      expect(photo).toMatchObject({ position: 0, width: 320, height: 240 });
      expect(photo.v).toHaveLength(8);

      const blobs = await sql`select variant, bytes, sha256, width from photo_blob where photo_id = ${photo.id} order by variant`;
      expect(blobs.map((b) => b.variant)).toEqual(["lg", "md", "sm"]);
      for (const b of blobs) {
        expect(b.bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
        expect(b.bytes.includes(Buffer.from("Exif"))).toBe(false); // the fixture has EXIF; the output must not
        expect(b.bytes.includes(Buffer.from("GPS"))).toBe(false);
      }
      const [row] = await sql`select sha256, bytes_total from listing_photo where id = ${photo.id}`;
      expect(row.sha256).toBe(blobs.find((b) => b.variant === "lg")!.sha256);
      expect(Number(row.bytes_total)).toBe(blobs.reduce((n, b) => n + b.bytes.length, 0));
      expect(photo.v).toBe(row.sha256.slice(0, 8));
    });

    it("the second photo goes to position 1", async () => {
      const l = await newListing();
      expect((await uploadOk(l.id)).position).toBe(0);
      expect((await uploadOk(l.id, png, PNG)).position).toBe(1);
    });

    it("a foreign agent gets 404, whatever they send, and nothing is written", async () => {
      const l = await newListing(agent);
      as(agent2);
      const before = await uploadsUsed(agent2);
      expect((await upload(l.id, small)).status).toBe(404);
      expect((await upload(l.id, Buffer.from("<svg/>"), { type: "image/svg+xml" })).status).toBe(404); // not 415: ownership first
      expect((await upload(l.id, Buffer.alloc(4 * 1024 * 1024 + 1))).status).toBe(404); // not 413
      expect((await upload(uuid(), small)).status).toBe(404); // a missing id looks the same
      expect((await upload("not-a-uuid", small)).status).toBe(404);
      expect(await photoCount(l.id)).toBe(0);
      expect(await uploadsUsed(agent2)).toBe(before);
      // The data function says the same, with no route in front of it.
      await expect(Ph.uploadPhoto(agent2, l.id, { bytes: small, contentType: JPEG, clientOpId: uuid() })).rejects.toMatchObject({ status: 404 });
      await expect(Ph.deletePhoto(agent2, l.id, uuid())).rejects.toMatchObject({ status: 404 });
    });

    it("anonymous is 401; a buyer and an admin are 403 (admin is not an agent)", async () => {
      const l = await newListing();
      as(null);
      expect((await upload(l.id, small)).status).toBe(401);
      as(buyer);
      expect((await upload(l.id, small)).status).toBe(403);
      as(admin);
      expect((await upload(l.id, small)).status).toBe(403);
      expect(await photoCount(l.id)).toBe(0);
      await expect(Ph.uploadPhoto(buyer, l.id, { bytes: small, contentType: JPEG, clientOpId: uuid() })).rejects.toMatchObject({ status: 403 });
    });

    it("refuses a cross-origin or origin-less upload", async () => {
      const l = await newListing();
      expect((await upload(l.id, small, { headers: { origin: "https://evil.example" } })).status).toBe(403);
      const noOrigin = await Upload.POST(
        new Request(`${BASE}/x`, { method: "POST", headers: { "content-type": JPEG, "x-client-op": uuid() }, body: new Uint8Array(small) }),
        { params: Promise.resolve({ id: l.id }) },
      );
      expect(noOrigin.status).toBe(403);
    });
  });

  // =================================================================================================================
  describe("upload: type, magic bytes and size", () => {
    it("bytes that are not the declared type are 415, and nothing reaches the image module", async () => {
      const l = await newListing();
      const svg = await readFixture("vector.svg");
      const gif = await readFixture("tiny.gif");
      const pdf = await readFixture("document.pdf");
      const cases: [string, Uint8Array, string][] = [
        ["png bytes as jpeg", png, JPEG],
        ["jpeg bytes as png", small, PNG],
        ["svg as png", svg, PNG],
        ["svg as webp", svg, "image/webp"],
        ["gif as jpeg", gif, JPEG],
        ["pdf as jpeg", pdf, JPEG],
        ["html as jpeg", Buffer.from("<html><script>alert(1)</script></html>"), JPEG],
        ["empty", Buffer.alloc(0), JPEG],
      ];
      for (const [name, body, type] of cases) {
        const res = await upload(l.id, body, { type });
        expect(res.status, name).toBe(415);
        expect((await res.json()).code, name).toBe("unsupported");
      }
      expect(proc.calls).toBe(0);
      expect(await photoCount(l.id)).toBe(0);
      expect(await uploadsUsed(agent)).toBe(0); // junk never costs an allowance
    });

    it("a declared type that is not one of the three is 415, before the body is read", async () => {
      const l = await newListing();
      for (const type of ["image/svg+xml", "image/gif", "image/heic", "application/pdf", "text/html", "application/octet-stream", null, ""]) {
        expect((await upload(l.id, small, { type })).status, String(type)).toBe(415);
      }
      // Parameters don't change the type: `image/jpeg; charset=binary` is still a JPEG claim.
      expect((await upload(l.id, small, { type: "IMAGE/JPEG; charset=binary" })).status).toBe(201);
    });

    it("a missing or malformed x-client-op is 400", async () => {
      const l = await newListing();
      expect((await upload(l.id, small, { op: null })).status).toBe(400);
      expect((await upload(l.id, small, { op: "not-a-uuid" })).status).toBe(400);
      expect(await photoCount(l.id)).toBe(0);
    });

    it("more than 4 MB is 413, whether the length is declared or only counted while streaming", async () => {
      const l = await newListing();
      const big = Buffer.alloc(4 * 1024 * 1024 + 1);
      Buffer.from([0xff, 0xd8, 0xff]).copy(big); // real JPEG magic: only the size is wrong
      expect((await upload(l.id, big)).status).toBe(413); // no content-length on the Request: counted while reading
      const declared = await upload(l.id, small, { headers: { "content-length": String(big.length) } });
      expect(declared.status).toBe(413); // a lying or honest header is refused before the body is read
      expect(proc.calls).toBe(0);
      expect(await photoCount(l.id)).toBe(0);
    });

    it("exactly 4 MB is not too large", async () => {
      // 4 MiB of JPEG magic and zeros is not a decodable photo: the point is that it gets past the size check and
      // is refused by the decoder (422) rather than by the cap (413).
      const l = await newListing();
      const body = Buffer.alloc(4 * 1024 * 1024);
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(body);
      const res = await upload(l.id, body);
      expect(res.status).toBe(422);
    });

    it("a photo that can't be read is 422 and stores nothing", async () => {
      const l = await newListing();
      const res = await upload(l.id, await readFixture("truncated.jpg"));
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe("decode_failed");
      expect(await photoCount(l.id)).toBe(0);
      expect(await blobCount(l.id)).toBe(0);
    });
  });

  // =================================================================================================================
  describe("upload: caps and allowance", () => {
    const fillPhotos = async (listingId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await sql`insert into listing_photo (listing_id, position, width, height, bytes_total, sha256) values (${listingId}, ${i}, 10, 10, 3, ${"ab".repeat(32)})`;
      }
    };

    it("the 13th photo is 409, before anything is processed or charged", async () => {
      const l = await newListing();
      await fillPhotos(l.id, 12);
      const res = await upload(l.id, small);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/at most 12/);
      expect(proc.calls).toBe(0);
      expect(await photoCount(l.id)).toBe(12);
      expect(await uploadsUsed(agent)).toBe(0);
    });

    it("the 12th is fine, and deleting one makes room again", async () => {
      const l = await newListing();
      await fillPhotos(l.id, 11);
      const twelfth = await uploadOk(l.id);
      expect(twelfth.position).toBe(11);
      expect((await upload(l.id, small)).status).toBe(409);
      expect((await del(l.id, twelfth.id)).status).toBe(204);
      expect((await upload(l.id, small)).status).toBe(201);
    });

    /** The cap is app-wide and these tests need to know exactly how full the store is: empty this suite's share of it. */
    const clearStore = () => sql`delete from listing_photo where listing_id in (select id from listing where agent_id like ${P + "-%"})`;

    it("the app-wide store cap is 409 up front when it is already reached", async () => {
      await clearStore();
      const l = await newListing();
      const [{ total }] = await sql`select coalesce(sum(bytes_total), 0)::bigint as total from listing_photo`;
      const cap = 1024 * 1024;
      process.env.PHOTO_STORE_CAP_MB = "1";
      envMod.resetEnvCache();
      const filler = await newListing();
      await sql`insert into listing_photo (listing_id, position, width, height, bytes_total, sha256) values (${filler.id}, 0, 10, 10, ${cap + 1 - Number(total)}, ${"cd".repeat(32)})`;
      const res = await upload(l.id, small);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/storage limit/);
      expect(proc.calls).toBe(0); // checked before processing
      expect(await uploadsUsed(agent)).toBe(0);
      expect(await photoCount(l.id)).toBe(0);
    });

    it("the cap is enforced again after processing, with the real size, and the allowance is handed back", async () => {
      await clearStore();
      const l = await newListing();
      const [{ total }] = await sql`select coalesce(sum(bytes_total), 0)::bigint as total from listing_photo`;
      const cap = 1024 * 1024;
      process.env.PHOTO_STORE_CAP_MB = "1";
      envMod.resetEnvCache();
      const filler = await newListing();
      // 100 bytes of room: enough to start, not enough for three WebP variants.
      await sql`insert into listing_photo (listing_id, position, width, height, bytes_total, sha256) values (${filler.id}, 0, 10, 10, ${cap - 100 - Number(total)}, ${"cd".repeat(32)})`;
      const res = await upload(l.id, small);
      expect(res.status).toBe(409);
      expect(proc.calls).toBe(1); // it was processed...
      expect(await photoCount(l.id)).toBe(0); // ...and nothing was stored
      expect(await blobCount(l.id)).toBe(0);
      expect(await uploadsUsed(agent)).toBe(0); // and it wasn't charged
    });

    it("60 uploads an hour per agent: the 61st is 429 and stores nothing", async () => {
      const l = await newListing();
      await sql`insert into rate_event (user_id, kind) select ${agent.id}, 'photo_upload' from generate_series(1, 60)`;
      const res = await upload(l.id, small);
      expect(res.status).toBe(429);
      expect(proc.calls).toBe(0);
      expect(await photoCount(l.id)).toBe(0);
      expect(await uploadsUsed(agent)).toBe(60);
      // Another agent is unaffected.
      as(agent2);
      const mine = await newListing(agent2);
      expect((await upload(mine.id, small)).status).toBe(201);
    });

    it("charges one allowance per stored photo, not per attempt", async () => {
      const l = await newListing();
      await uploadOk(l.id);
      expect(await uploadsUsed(agent)).toBe(1);
    });

    it("refunds when the gate was full or its wait ran out, and keeps the charge when the work ran", async () => {
      const l = await newListing();
      const { ImageError } = ImageModule;
      const refused = (reason: "busy" | "queue_timeout" | "timeout" | "decode_failed" | "too_large_after_encode") => {
        proc.override = () => Promise.reject(new ImageError(reason));
      };

      refused("busy");
      let res = await upload(l.id, small);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("3");
      expect((await res.json()).code).toBe("busy");
      expect(await uploadsUsed(agent)).toBe(0);

      refused("queue_timeout");
      res = await upload(l.id, small);
      expect(res.status).toBe(503); // not a 504
      expect(res.headers.get("retry-after")).toBe("5");
      expect((await res.json()).code).toBe("busy");
      expect(await uploadsUsed(agent)).toBe(0);

      refused("timeout");
      res = await upload(l.id, small);
      expect(res.status).toBe(504);
      expect(await uploadsUsed(agent)).toBe(1); // the work ran: no free retries against the gate

      refused("decode_failed");
      expect((await upload(l.id, small)).status).toBe(422);
      refused("too_large_after_encode");
      expect((await upload(l.id, small)).status).toBe(422);
      expect(await uploadsUsed(agent)).toBe(3);
      expect(await photoCount(l.id)).toBe(0);
    });

    it("a gate that is really full answers 429 busy to the third caller, and the refused uploads aren't charged", async () => {
      const bytes = await readFixture("q100-2048.jpg");
      const l = await newListing();
      const results = await Promise.all([1, 2, 3].map(() => upload(l.id, bytes)));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 201, 429]);
      const busy = results.find((r) => r.status === 429)!;
      expect(busy.headers.get("retry-after")).toBe("3");
      expect(await uploadsUsed(agent)).toBe(2);
      expect(await photoCount(l.id)).toBe(2);
    }, 120_000);
  });

  // =================================================================================================================
  describe("upload: in-flight admission (bounds the memory of bodies being read)", () => {
    /** An upload whose body has not finished arriving: it holds its slot until `finish`, `empty` or `fail` is called. */
    const stalled = (listingId: string) => {
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
      const response = Upload.POST(
        new Request(`${BASE}/api/listings/${listingId}/photos`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": JPEG, "x-client-op": uuid() },
          body,
          duplex: "half",
        } as RequestInit),
        { params: Promise.resolve({ id: listingId }) },
      );
      return {
        response,
        finish: () => (ctl.enqueue(new Uint8Array(small)), ctl.close()),
        empty: () => ctl.close(),
        fail: () => ctl.error(new Error("connection reset")),
      };
    };
    const settle = () => new Promise((r) => setTimeout(r, 50));

    it("refuses the upload over the bound with 503 busy and Retry-After, immediately, before reading its body", async () => {
      const l = await newListing();
      const held = Array.from({ length: Ph.MAX_UPLOADS_IN_FLIGHT }, () => stalled(l.id));
      await settle();
      expect(Ph.uploadsInFlightNow()).toBe(Ph.MAX_UPLOADS_IN_FLIGHT);

      // One more. Without the admission this would sit waiting for its body (and hold up to 4 MB); it must answer now.
      const extra = stalled(l.id);
      const res = await Promise.race([extra.response, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
      expect(res, "the extra upload was queued instead of refused").not.toBeNull();
      expect(res!.status).toBe(503);
      expect(res!.headers.get("retry-after")).toBe("5");
      expect((await res!.json()).code).toBe("busy");
      expect(Ph.uploadsInFlightNow()).toBe(Ph.MAX_UPLOADS_IN_FLIGHT); // the refused one took nothing
      expect(await uploadsUsed(agent)).toBe(0);

      for (const h of held) h.empty();
      for (const h of held) expect((await h.response).status).toBe(415);
      expect(Ph.uploadsInFlightNow()).toBe(0);
    });

    it("frees a slot when an upload finishes, so the next one is admitted", async () => {
      const l = await newListing();
      const held = Array.from({ length: Ph.MAX_UPLOADS_IN_FLIGHT }, () => stalled(l.id));
      await settle();
      held[0].finish();
      expect((await held[0].response).status).toBe(201);
      expect(Ph.uploadsInFlightNow()).toBe(Ph.MAX_UPLOADS_IN_FLIGHT - 1);
      expect((await upload(l.id, small)).status).toBe(201);
      for (const h of held.slice(1)) h.empty();
      await Promise.all(held.slice(1).map((h) => h.response));
      expect(Ph.uploadsInFlightNow()).toBe(0);
    });

    it("a body that throws mid-read does not leak its slot", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const l = await newListing();
      for (let round = 0; round < Ph.MAX_UPLOADS_IN_FLIGHT + 2; round++) {
        const h = stalled(l.id);
        await settle();
        h.fail();
        expect((await h.response).status).toBe(500);
      }
      expect(Ph.uploadsInFlightNow()).toBe(0);
      vi.restoreAllMocks();
      expect((await upload(l.id, small)).status).toBe(201);
    });

    it("refusals before the body (wrong owner, bad type) don't take a slot", async () => {
      const l = await newListing();
      as(agent2);
      for (let i = 0; i < Ph.MAX_UPLOADS_IN_FLIGHT + 2; i++) expect((await upload(l.id, small)).status).toBe(404);
      as(agent);
      for (let i = 0; i < Ph.MAX_UPLOADS_IN_FLIGHT + 2; i++) expect((await upload(l.id, small, { type: "image/gif" })).status).toBe(415);
      expect(Ph.uploadsInFlightNow()).toBe(0);
    });
  });

  // =================================================================================================================
  describe("upload: idempotency", () => {
    it("the same x-client-op is one photo: a retry returns the first, 200, and costs nothing", async () => {
      const l = await newListing();
      const op = uuid();
      const first = await upload(l.id, small, { op });
      expect(first.status).toBe(201);
      const firstPhoto = (await first.json()).photo;
      const calls = proc.calls;
      const again = await upload(l.id, small, { op });
      expect(again.status).toBe(200);
      expect((await again.json()).photo).toEqual(firstPhoto);
      expect(proc.calls).toBe(calls); // not processed again
      expect(await photoCount(l.id)).toBe(1);
      expect(await blobCount(l.id)).toBe(3);
      expect(await uploadsUsed(agent)).toBe(1);
      // Same op, a different file: still the first photo (the op is the intent).
      expect((await (await upload(l.id, png, { op, type: PNG })).json()).photo.id).toBe(firstPhoto.id);
    });

    it("parallel retries of one op make one photo and one charge", async () => {
      const l = await newListing();
      const op = uuid();
      const results = await Promise.all([upload(l.id, small, { op }), upload(l.id, small, { op })]);
      const bodies = await Promise.all(results.map((r) => r.json()));
      expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
      expect(bodies[0].photo.id).toBe(bodies[1].photo.id);
      expect(await photoCount(l.id)).toBe(1);
      expect(await blobCount(l.id)).toBe(3);
      expect(await uploadsUsed(agent)).toBe(1); // the loser's charge was handed back
    });

    it("an op id is per listing: the same id on another listing makes its own photo", async () => {
      const a = await newListing();
      const b = await newListing();
      const op = uuid();
      const pa = await ok(await upload(a.id, small, { op }));
      const pb = await ok(await upload(b.id, small, { op }));
      expect(pa.id).not.toBe(pb.id);
    });

    it("the unique index, not just the check, holds the line", async () => {
      const l = await newListing();
      const op = uuid();
      await sql`insert into listing_photo (listing_id, position, width, height, bytes_total, sha256, client_op_id) values (${l.id}, 0, 1, 1, 1, 'x', ${op})`;
      await expect(
        sql`insert into listing_photo (listing_id, position, width, height, bytes_total, sha256, client_op_id) values (${l.id}, 1, 1, 1, 1, 'x', ${op})`,
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  // =================================================================================================================
  describe("alt text, order and delete", () => {
    it("PATCH sets alt text through text(): trimmed, capped at 150, NUL rejected", async () => {
      const l = await newListing();
      const p = await uploadOk(l.id);
      let res = await patch(l.id, p.id, { alt: "  Sunny kitchen  " });
      expect(res.status).toBe(200);
      expect((await sql`select alt from listing_photo where id = ${p.id}`)[0].alt).toBe("Sunny kitchen");
      expect((await patch(l.id, p.id, { alt: "x".repeat(151) })).status).toBe(400);
      res = await patch(l.id, p.id, { alt: "bad\u0000alt" });
      expect(res.status).toBe(400);
      expect((await patch(l.id, p.id, {})).status).toBe(400);
      expect((await patch(l.id, p.id, { position: -1 })).status).toBe(400);
      expect((await sql`select alt from listing_photo where id = ${p.id}`)[0].alt).toBe("Sunny kitchen");
    });

    it("moving a photo renumbers 0..n-1, so position 0 is always the cover", async () => {
      const l = await newListing();
      const [a, b, c] = [await uploadOk(l.id), await uploadOk(l.id), await uploadOk(l.id)];
      const res = await patch(l.id, c.id, { position: 0 });
      const order = ((await res.json()).photos as { id: string; position: number }[]).map((p) => p.id);
      expect(order).toEqual([c.id, a.id, b.id]);
      expect((await sql`select position from listing_photo where listing_id = ${l.id} order by position`).map((r) => r.position)).toEqual([0, 1, 2]);
      const last = await patch(l.id, c.id, { position: 11 }); // past the end means last
      expect(((await last.json()).photos as { id: string }[]).map((p) => p.id)).toEqual([a.id, b.id, c.id]);
    });

    it("another agent's PATCH and DELETE are 404 and change nothing; a buyer is 403", async () => {
      const l = await newListing();
      const p = await uploadOk(l.id);
      as(agent2);
      expect((await patch(l.id, p.id, { alt: "stolen" })).status).toBe(404);
      expect((await del(l.id, p.id)).status).toBe(404);
      as(buyer);
      expect((await del(l.id, p.id)).status).toBe(403);
      expect((await patch(l.id, p.id, { alt: "x" })).status).toBe(403);
      as(agent);
      expect(await blobCount(l.id)).toBe(3);
      expect((await sql`select alt from listing_photo where id = ${p.id}`)[0].alt).toBe("");
      // A photo id from another listing of the same agent isn't addressable through this listing.
      const other = await newListing();
      expect((await del(other.id, p.id)).status).toBe(404);
    });

    it("deleting a photo deletes its three blobs and closes the gap in the order", async () => {
      const l = await newListing();
      const [a, b, c] = [await uploadOk(l.id), await uploadOk(l.id), await uploadOk(l.id)];
      expect(await blobCount(l.id)).toBe(9);
      expect((await del(l.id, a.id)).status).toBe(204); // the cover
      expect(await photoCount(l.id)).toBe(2);
      expect(await blobCount(l.id)).toBe(6);
      expect((await sql`select count(*)::int as n from photo_blob where photo_id = ${a.id}`)[0].n).toBe(0);
      const left = await sql`select id, position from listing_photo where listing_id = ${l.id} order by position`;
      expect(left.map((r) => [r.id, r.position])).toEqual([[b.id, 0], [c.id, 1]]);
      expect((await del(l.id, a.id)).status).toBe(404); // already gone
    });

    it("deleting the listing deletes every photo and blob with it", async () => {
      const l = await newListing();
      await uploadOk(l.id);
      await uploadOk(l.id);
      const ids = (await sql`select id from listing_photo where listing_id = ${l.id}`).map((r) => r.id);
      expect(await blobCount(l.id)).toBe(6);
      await L.deleteListing(agent, l.id);
      expect((await sql`select count(*)::int as n from listing_photo where id in ${sql(ids)}`)[0].n).toBe(0);
      expect((await sql`select count(*)::int as n from photo_blob where photo_id in ${sql(ids)}`)[0].n).toBe(0);
    });

    it("the last photo of a public listing can't be deleted", async () => {
      const { listing, photo } = await publishListing();
      const res = await del(listing.id, photo.id);
      expect(res.status).toBe(409);
      expect(await photoCount(listing.id)).toBe(1);
    });
  });

  // =================================================================================================================
  describe("serving: a public photo", () => {
    it("200 with immutable caching, the ETag, a fixed image/webp type, nosniff and a default-src 'none' CSP", async () => {
      const { photo } = await publishListing();
      as(null);
      const res = await get(photo.id, "lg");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("content-type")).toBe("image/webp");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
      const [blob] = await sql`select bytes, sha256 from photo_blob where photo_id = ${photo.id} and variant = 'lg'`;
      expect(res.headers.get("etag")).toBe(`"${blob.sha256}"`);
      expect(Buffer.from(await res.arrayBuffer()).equals(blob.bytes)).toBe(true);
      expect(res.headers.get("content-length")).toBe(String(blob.bytes.length));
      for (const variant of ["md", "sm"]) expect((await get(photo.id, variant)).status).toBe(200);
    });

    it("answers If-None-Match with 304 carrying the same validators, and 200 for any other tag", async () => {
      const { photo } = await publishListing();
      as(null);
      const etag = (await get(photo.id, "md")).headers.get("etag")!;
      for (const header of [etag, `W/${etag}`, `"zzz", ${etag}`, "*"]) {
        const res = await get(photo.id, "md", { "if-none-match": header });
        expect(res.status, header).toBe(304);
        expect(res.headers.get("etag")).toBe(etag);
        expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect((await res.arrayBuffer()).byteLength).toBe(0);
      }
      expect((await get(photo.id, "md", { "if-none-match": '"not-this-one"' })).status).toBe(200);
      // Each variant has its own tag: lg's validator doesn't validate md.
      const lgTag = (await get(photo.id, "lg")).headers.get("etag")!;
      expect(lgTag).not.toBe(etag);
      expect((await get(photo.id, "md", { "if-none-match": lgTag })).status).toBe(200);
    });

    it("a signed-in stranger and the owner both get the public answer for a public photo", async () => {
      const { photo } = await publishListing();
      for (const who of [buyer, agent2, admin, agent]) {
        as(who);
        const res = await get(photo.id);
        expect(res.status, who.id).toBe(200);
        expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      }
    });

    it("answers the 304 without reading `bytes`: a role that may not read that column still gets it", async () => {
      const { photo } = await publishListing();
      const etag = `"${(await sql`select sha256 from photo_blob where photo_id = ${photo.id} and variant = 'sm'`)[0].sha256}"`;
      const role = `ph_noread_${Date.now().toString(36)}`;
      await sql.unsafe(`create role ${role} login password 'x'`);
      try {
        await sql.unsafe(`grant usage on schema public to ${role}`);
        await sql.unsafe(`grant select on listing, listing_photo to ${role}`);
        // Every column of photo_blob except `bytes`.
        await sql.unsafe(`grant select (photo_id, variant, sha256, width, height) on photo_blob to ${role}`);
        const restricted = new URL(url!);
        restricted.username = role;
        restricted.password = "x";

        await withDbAs(restricted.toString(), async () => {
          as(null);
          // 1. The trap bites: the same role asking for the bytes fails inside Postgres.
          const full = await get(photo.id, "sm");
          expect(full.status).toBe(500);
          // 2. The conditional request is answered all the same, because its query never names the column.
          const notModified = await get(photo.id, "sm", { "if-none-match": etag });
          expect(notModified.status).toBe(304);
          expect(notModified.headers.get("etag")).toBe(etag);
          // 3. Nor does the access decision touch it: a missing id, and a draft's photo, are 404 and not 500.
          expect((await get(uuid(), "sm", { "if-none-match": etag })).status).toBe(404);
        });
      } finally {
        await sql.unsafe(`drop owned by ${role}`);
        await sql.unsafe(`drop role ${role}`);
      }
    });

    it("a 304 for a draft or hidden photo is still a 404 under the same restriction", async () => {
      const draft = await newListing();
      as(agent);
      const dp = await uploadOk(draft.id);
      const etag = `"${(await sql`select sha256 from photo_blob where photo_id = ${dp.id} and variant = 'md'`)[0].sha256}"`;
      const role = `ph_noread2_${Date.now().toString(36)}`;
      await sql.unsafe(`create role ${role} login password 'x'`);
      try {
        await sql.unsafe(`grant usage on schema public to ${role}`);
        await sql.unsafe(`grant select on listing, listing_photo to ${role}`);
        await sql.unsafe(`grant select (photo_id, variant, sha256, width, height) on photo_blob to ${role}`);
        const restricted = new URL(url!);
        restricted.username = role;
        restricted.password = "x";
        await withDbAs(restricted.toString(), async () => {
          as(null);
          expect((await get(dp.id, "md", { "if-none-match": etag })).status).toBe(404);
          expect((await get(dp.id, "md")).status).toBe(404);
        });
      } finally {
        await sql.unsafe(`drop owned by ${role}`);
        await sql.unsafe(`drop role ${role}`);
      }
    });
  });

  // =================================================================================================================
  describe("serving: who must not get a photo", () => {
    it("a draft's photo is 404 for everyone but its agent, including with If-None-Match", async () => {
      const l = await newListing();
      const p = await uploadOk(l.id);
      const etag = `"${(await sql`select sha256 from photo_blob where photo_id = ${p.id} and variant = 'md'`)[0].sha256}"`;
      for (const who of [null, buyer, agent2, admin]) {
        as(who);
        for (const headers of [{}, { "if-none-match": etag }, { "if-none-match": "*" }] as Record<string, string>[]) {
          const res = await get(p.id, "md", headers);
          expect(res.status, `${who?.id ?? "anonymous"} ${JSON.stringify(headers)}`).toBe(404);
          expect(res.headers.get("cache-control")).toBe("no-store");
        }
      }
      // The same answer as a photo that does not exist.
      as(null);
      const missing = await get(uuid(), "md");
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual(await (await get(p.id, "md")).json());
    });

    it("the owner gets their draft's photo as private, no-store, with no validator to revalidate with", async () => {
      const l = await newListing();
      const p = await uploadOk(l.id);
      as(agent);
      const res = await get(p.id, "lg");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("etag")).toBeNull();
      expect(res.headers.get("content-type")).toBe("image/webp");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
      // A conditional request from the owner is answered in full: no-store means there is nothing to revalidate.
      const etag = `"${(await sql`select sha256 from photo_blob where photo_id = ${p.id} and variant = 'lg'`)[0].sha256}"`;
      expect((await get(p.id, "lg", { "if-none-match": etag })).status).toBe(200);
    });

    it("a hidden listing's photo is 404 on the 200 path and on the 304 path, and the owner still sees it", async () => {
      const { listing, photo } = await publishListing();
      as(null);
      const etag = (await get(photo.id, "md")).headers.get("etag")!;
      // Control: before the hide, the same conditional request is a 304.
      expect((await get(photo.id, "md", { "if-none-match": etag })).status).toBe(304);

      await A.hideListing(admin, listing.id, { hidden: true, reason: "test hide" });
      for (const who of [null, buyer, agent2, admin]) {
        as(who);
        expect((await get(photo.id, "md")).status, `${who?.id ?? "anon"} 200 path`).toBe(404);
        expect((await get(photo.id, "md", { "if-none-match": etag })).status, `${who?.id ?? "anon"} 304 path`).toBe(404);
        expect((await get(photo.id, "md", { "if-none-match": "*" })).status).toBe(404);
      }
      as(agent);
      const mine = await get(photo.id, "md", { "if-none-match": etag });
      expect(mine.status).toBe(200);
      expect(mine.headers.get("cache-control")).toBe("private, no-store");

      await A.hideListing(admin, listing.id, { hidden: false });
      as(null);
      expect((await get(photo.id, "md", { "if-none-match": etag })).status).toBe(304);
    });

    it("withdrawn and sold listings stop serving, on both paths", async () => {
      const { listing, photo } = await publishListing();
      as(null);
      const etag = (await get(photo.id, "sm")).headers.get("etag")!;
      let version = listing.version + 1;
      for (const status of ["withdrawn", "active", "sold"] as const) {
        const updated = await L.updateListing(agent, listing.id, { version, status });
        version = updated.version;
        if (status === "active") {
          expect((await get(photo.id, "sm", { "if-none-match": etag })).status).toBe(304);
          continue;
        }
        expect((await get(photo.id, "sm")).status, status).toBe(404);
        expect((await get(photo.id, "sm", { "if-none-match": etag })).status, status).toBe(404);
      }
    });

    it("an unknown photo, a malformed id and an unknown variant are all the same 404", async () => {
      const { photo } = await publishListing();
      as(null);
      for (const [id, variant] of [[uuid(), "md"], ["nope", "md"], [photo.id, "xl"], [photo.id, "original"], [photo.id, "MD"], [photo.id, "../md"]] as const) {
        const res = await get(id, variant);
        expect(res.status, `${id} ${variant}`).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    });

    it("never serves bytes that are not WebP: a stored SVG or HTML is a 404, not image/svg+xml", async () => {
      const { listing, photo } = await publishListing();
      as(null);
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
      const html = Buffer.from("<html><script>alert(1)</script></html>");
      for (const [variant, body] of [["lg", svg], ["md", html], ["sm", await readFixture("tiny.gif")]] as const) {
        await sql`update photo_blob set bytes = ${body} where photo_id = ${photo.id} and variant = ${variant}`;
        const res = await get(photo.id, variant);
        expect(res.status, variant).toBe(404);
        expect(res.headers.get("content-type") ?? "").not.toMatch(/svg|html|gif/);
        expect(res.headers.get("content-type") ?? "").toMatch(/json/);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await res.text()).not.toContain("<svg");
      }
      // The owner can't be handed one either.
      as(agent);
      expect((await get(photo.id, "lg")).status).toBe(404);
      expect(listing.id).toBeTruthy();
    });
  });

  // =================================================================================================================
  describe("serving: rate limits", () => {
    it("img hits don't consume the public allowance, and have their own 600 a minute", async () => {
      const { photo, listing } = await publishListing();
      as(null);
      const same = "203.0.113.77";
      const etag = (await get(photo.id, "sm", { "x-forwarded-for": same })).headers.get("etag")!;
      ipLimit.resetPublicLimiter();
      // 70 image hits from one IP: more than the 60 a minute the public namespace allows.
      for (let i = 0; i < 70; i++) {
        expect((await get(photo.id, "sm", { "x-forwarded-for": same, "if-none-match": etag })).status).toBe(304);
      }
      // That IP still has its whole public allowance.
      const listingRes = await ListingApi.GET(new Request(`${BASE}/api/listings/${listing.id}`, { headers: { "x-forwarded-for": same } }), {
        params: Promise.resolve({ id: listing.id }),
      });
      expect(listingRes.status).toBe(200);
      // And the reverse: spend all of public, img is untouched.
      for (let i = 0; i < 60; i++) {
        await ListingApi.GET(new Request(`${BASE}/api/listings/${listing.id}`, { headers: { "x-forwarded-for": same } }), { params: Promise.resolve({ id: listing.id }) });
      }
      expect((await get(photo.id, "sm", { "x-forwarded-for": same, "if-none-match": etag })).status).toBe(304);
    });

    it("the 601st image request in a minute is 429 with Retry-After, and a different IP is unaffected", async () => {
      const { photo } = await publishListing();
      as(null);
      const same = "203.0.113.88";
      const etag = (await get(photo.id, "sm", { "x-forwarded-for": same })).headers.get("etag")!;
      ipLimit.resetPublicLimiter();
      for (let i = 0; i < 600; i++) {
        const res = await get(photo.id, "sm", { "x-forwarded-for": same, "if-none-match": etag });
        if (res.status !== 304) throw new Error(`request ${i + 1} was ${res.status}`);
      }
      const limited = await get(photo.id, "sm", { "x-forwarded-for": same, "if-none-match": etag });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("10");
      expect(limited.headers.get("cache-control")).toBe("no-store");
      expect((await get(photo.id, "sm", { "x-forwarded-for": "203.0.113.89", "if-none-match": etag })).status).toBe(304);
    }, 60_000);
  });

  // =================================================================================================================
  describe("the constants the data layer and the image module must agree on", () => {
    it("PHOTO_MAX_BYTES and the accepted types match the image module", () => {
      expect(Ph.PHOTO_MAX_BYTES).toBe(ImageModule.MAX_INPUT_BYTES);
      expect([...Ph.PHOTO_UPLOAD_TYPES]).toEqual([...ImageModule.IMAGE_CONTENT_TYPES]);
    });
  });

  // -----------------------------------------------------------------------------------------------------------------

  /** Run `fn` with the app's database handle connected as another role, then put the real one back. */
  async function withDbAs(connectionUrl: string, fn: () => Promise<void>) {
    const g = globalThis as unknown as { sql?: postgres.Sql; db?: unknown };
    const saved = { sql: g.sql, db: g.db };
    const savedUrl = process.env.DATABASE_URL;
    g.sql = undefined;
    g.db = undefined;
    process.env.DATABASE_URL = connectionUrl;
    envMod.resetEnvCache();
    vi.spyOn(console, "error").mockImplementation(() => undefined); // the deliberate 500 logs its error
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await fn();
    } finally {
      vi.restoreAllMocks();
      await (g.sql as postgres.Sql | undefined)?.end({ timeout: 2 });
      g.sql = saved.sql;
      g.db = saved.db;
      process.env.DATABASE_URL = savedUrl;
      envMod.resetEnvCache();
    }
  }
});
