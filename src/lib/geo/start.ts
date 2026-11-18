import "server-only";
import { log } from "@/lib/log";
import { safeErrorFields } from "@/lib/safe-error";

/**
 * Called from `instrumentation.ts`: once migrations are done, load the ZIP centroids when the table is empty.
 * A failure is logged and swallowed (the ZIP route answers 404 until a later start loads them).
 */
export async function startZipLoad(): Promise<void> {
  try {
    const { whenMigrated } = await import("../db/migrate-on-start");
    await whenMigrated();
    const url = process.env.DATABASE_URL;
    if (!url) return;
    const [{ default: postgres }, { loadZipCentroids }] = await Promise.all([import("postgres"), import("./zip-load")]);
    const sql = postgres(url, { max: 1, connect_timeout: 10 });
    try {
      await loadZipCentroids(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  } catch (err) {
    log.error("geo.zip_load_failed", safeErrorFields(err));
  }
}
