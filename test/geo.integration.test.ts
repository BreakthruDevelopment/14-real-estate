/** ZIP centroid loader and radius SQL against a real Postgres (TEST_DATABASE_URL). */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql as dsql } from "drizzle-orm";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { haversineMiles } from "@/lib/geo/distance";
import { distanceMilesSql, withinRadiusSql } from "@/lib/geo/sql";
import { loadZipCentroids } from "@/lib/geo/zip-load";

const url = process.env.TEST_DATABASE_URL;
const FILE = path.join(process.cwd(), "data", "zcta-centroids.csv.gz");
const fileRows = () => gunzipSync(readFileSync(FILE)).toString().trim().split("\n").length - 1;

describe.skipIf(!url)("ZIP centroids and radius SQL (Postgres)", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => {
    await sql.end();
  });

  it("loads the whole file once, and a second run changes nothing", async () => {
    await sql`delete from zip_centroid`;
    const first = await loadZipCentroids(sql);
    expect(first.skipped).toBe(false);
    expect(first.loaded).toBe(fileRows());
    expect(first.loaded).toBeGreaterThan(40_000);
    const [{ n }] = await sql`select count(*)::int n from zip_centroid`;
    expect(n).toBe(first.loaded);
    const [austin] = await sql`select lat::float8 lat, lng::float8 lng from zip_centroid where zip = '78704'`;
    expect(haversineMiles(austin.lat, austin.lng, 30.2423, -97.769)).toBeLessThan(1);

    const second = await loadZipCentroids(sql);
    expect(second).toEqual({ loaded: 0, skipped: true });
    const [{ n: after }] = await sql`select count(*)::int n from zip_centroid`;
    expect(after).toBe(n);
  });

  it("does not overwrite rows that are already there", async () => {
    await sql`update zip_centroid set lat = 31 where zip = '78704'`;
    await loadZipCentroids(sql);
    const [r] = await sql`select lat::float8 lat from zip_centroid where zip = '78704'`;
    expect(r.lat).toBe(31);
    await sql`update zip_centroid set lat = 30.24068 where zip = '78704'`;
  });

  it("runs once when several instances start together", async () => {
    await sql`delete from zip_centroid`;
    const results = await Promise.all([1, 2, 3].map(() => loadZipCentroids(sql)));
    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    expect(results.filter((r) => r.skipped)).toHaveLength(2);
    const [{ n }] = await sql`select count(*)::int n from zip_centroid`;
    expect(n).toBe(fileRows());
  });

  it("SQL haversine agrees with the TypeScript one and with known distances", async () => {
    const d = drizzle(sql);
    const [row] = await d.execute(dsql`select ${distanceMilesSql({ lat: 30.2672, lng: -97.7431 }, { lat: dsql`32.7767`, lng: dsql`-96.797` })} as miles`);
    const miles = Number((row as { miles: number }).miles);
    expect(Math.abs(miles - haversineMiles(30.2672, -97.7431, 32.7767, -96.797))).toBeLessThan(1e-6);
    expect(Math.abs(miles - 182) / 182).toBeLessThan(0.005);
    const [ny] = await d.execute(dsql`select ${distanceMilesSql({ lat: 40.7128, lng: -74.006 }, { lat: dsql`34.0522`, lng: dsql`-118.2437` })} as miles`);
    expect(Math.abs(Number((ny as { miles: number }).miles) - 2445) / 2445).toBeLessThan(0.005);
  });

  it("a 10-mile query includes a point at 9.9 mi and excludes one at 10.1 mi", async () => {
    const d = drizzle(sql);
    const center = { lat: 30.2, lng: -97.7 };
    const perMile = 1 / 69.0934;
    const east = (mi: number) => center.lng + mi * perMile / Math.cos((center.lat * Math.PI) / 180);
    await sql`delete from zip_centroid where zip in ('00001','00002','00003','00004')`;
    await sql`insert into zip_centroid (zip, lat, lng) values
      ('00001', ${center.lat + 9.9 * perMile}, ${center.lng}),
      ('00002', ${center.lat + 10.1 * perMile}, ${center.lng}),
      ('00003', ${center.lat}, ${east(9.9)}),
      ('00004', ${center.lat}, ${east(10.1)})`;
    try {
      const rows = await d.execute(dsql`select zip from zip_centroid where zip like '0000%' and ${withinRadiusSql(center, 10, { lat: dsql`lat`, lng: dsql`lng` })} order by zip`);
      expect((rows as unknown as { zip: string }[]).map((r) => r.zip)).toEqual(["00001", "00003"]);
    } finally {
      await sql`delete from zip_centroid where zip like '0000%'`;
    }
  });
});
