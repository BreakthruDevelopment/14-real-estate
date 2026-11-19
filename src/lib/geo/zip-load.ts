import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import type postgres from "postgres";
import { GEO_BOUNDS } from "@/lib/listing-schema";
import { log } from "@/lib/log";

const BATCH = 2_000;
const LOCK_NAME = "zip_centroid:load";

export const zipFile = () => process.env.ZIP_CENTROIDS_FILE ?? path.join(process.cwd(), "data", "zcta-centroids.csv.gz");

export type ZipRow = { zip: string; lat: number; lng: number };

/** Parse one `zip,lat,lng` line; null for the header, blanks and anything outside the US bounds. */
export function parseZipLine(line: string): ZipRow | null {
  const [zip, la, ln] = line.trim().split(",");
  if (!/^\d{5}$/.test(zip ?? "")) return null;
  const lat = Number(la);
  const lng = Number(ln);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < GEO_BOUNDS.latMin || lat > GEO_BOUNDS.latMax || lng < GEO_BOUNDS.lngMin || lng > GEO_BOUNDS.lngMax) return null;
  return { zip, lat, lng };
}

async function* readRows(file: string): AsyncGenerator<ZipRow> {
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    const row = parseZipLine(line);
    if (row) yield row;
  }
}

/**
 * Load the centroid file into `zip_centroid` when the table is empty. One transaction holds a transaction-level
 * advisory lock, so when several instances start together one loads and the others wait, then see a non-empty
 * table and do nothing. Idempotent: a second call loads nothing; inserts use `on conflict do nothing`.
 */
export async function loadZipCentroids(sql: postgres.Sql, file: string = zipFile()): Promise<{ loaded: number; skipped: boolean }> {
  const result = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${LOCK_NAME}, 0))`;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from zip_centroid`;
    if (n > 0) return { loaded: 0, skipped: true };
    let loaded = 0;
    let batch: ZipRow[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await tx`insert into zip_centroid ${tx(batch, "zip", "lat", "lng")} on conflict (zip) do nothing`;
      loaded += batch.length;
      batch = [];
    };
    for await (const row of readRows(file)) {
      batch.push(row);
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    return { loaded, skipped: false };
  });
  if (!result.skipped) log.info("geo.zip_loaded", { rows: result.loaded });
  return result;
}
