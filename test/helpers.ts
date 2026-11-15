/** Shared fixtures for the integration tests (listings, access, roles). Not a test file. */
import type postgres from "postgres";

export type TestActor = { id: string; role: "user" | "agent" | "admin" };

export async function makeUser(sql: postgres.Sql, prefix: string, name: string, role: TestActor["role"]): Promise<TestActor> {
  const id = `${prefix}-${name}`;
  await sql`insert into "user" (id, name, email, role) values (${id}, ${name}, ${id + "@test.local"}, ${role})`;
  return { id, role };
}

/** Delete everything the test created. Foreign keys to user are `restrict`, so children go first. */
export async function cleanup(sql: postgres.Sql, prefix: string) {
  const like = `${prefix}-%`;
  await sql`delete from description_draft where agent_id like ${like}`;
  await sql`delete from inquiry where buyer_id like ${like} or listing_id in (select id from listing where agent_id like ${like})`;
  await sql`delete from favorite where user_id like ${like} or listing_id in (select id from listing where agent_id like ${like})`;
  await sql`delete from listing where agent_id like ${like}`;
  await sql`delete from "user" where id like ${like}`;
}

/** Austin's 78704 centroid (approximately what the Census file has). Tests insert it so they don't depend on the 14.3 loader. */
export const ZIP_78704 = { zip: "78704", lat: 30.24235, lng: -97.76899 };

export async function seedCentroid(sql: postgres.Sql, c = ZIP_78704) {
  await sql`insert into zip_centroid (zip, lat, lng) values (${c.zip}, ${c.lat}, ${c.lng}) on conflict (zip) do update set lat = excluded.lat, lng = excluded.lng`;
}

export function facts(overrides: Record<string, unknown> = {}) {
  return {
    title: "Craftsman bungalow near Zilker",
    propertyType: "house",
    priceUsd: 450_000,
    beds: 3,
    baths: 2,
    sqft: 1640,
    yearBuilt: 1938,
    features: ["fenced_yard", "home_office"],
    addressLine: "123 Main St",
    city: "Austin",
    state: "TX",
    zip: "78704",
    description: "A".repeat(250),
    agentNotes: "private note for the agent",
    clientOpId: crypto.randomUUID(),
    ...overrides,
  };
}

export async function addPhoto(sql: postgres.Sql, listingId: string, position = 0) {
  const [{ id }] = await sql`
    insert into listing_photo (listing_id, position, width, height, bytes_total, sha256)
    values (${listingId}, ${position}, 1280, 960, 3, ${"ab".repeat(32)}) returning id`;
  for (const variant of ["lg", "md", "sm"]) {
    await sql`insert into photo_blob (photo_id, variant, bytes, sha256, width, height) values (${id}, ${variant}, ${Buffer.from([1, 2, 3])}, 'x', 1, 1)`;
  }
  return id as string;
}

/** Make a listing public through the data layer: photo, then publish. */
export async function publish(
  sql: postgres.Sql,
  updateListing: (actor: TestActor, id: string, input: unknown) => Promise<{ version: number }>,
  agent: TestActor,
  listing: { id: string; version: number },
) {
  await addPhoto(sql, listing.id);
  return updateListing(agent, listing.id, { version: listing.version, status: "active" });
}
