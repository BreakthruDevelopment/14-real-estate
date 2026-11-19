import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { NO_STORE, errorResponse } from "@/lib/http";
import { allowPublicRequest, clientIp } from "@/lib/ip-limit";

export const dynamic = "force-dynamic";

/** GET /api/geo/zip/:zip : the centroid of a ZIP for the listing editor and search. Public, per-IP limited. */
export async function GET(request: Request, ctx: { params: Promise<{ zip: string }> }) {
  try {
    if (!allowPublicRequest(clientIp(request))) throw new TooManyRequestsError();
    const { zip } = await ctx.params;
    if (!/^\d{5}$/.test(zip)) throw new NotFoundError();
    const [row] = await db().select({ zip: schema.zipCentroid.zip, lat: schema.zipCentroid.lat, lng: schema.zipCentroid.lng }).from(schema.zipCentroid).where(eq(schema.zipCentroid.zip, zip));
    if (!row) throw new NotFoundError();
    return Response.json(row, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
