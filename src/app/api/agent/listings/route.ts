import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { LISTING_STATUSES } from "@/lib/listing-schema";
import { createListing, listMyListings } from "@/lib/listings";

export const dynamic = "force-dynamic";

/** GET /api/agent/listings?status= : the agent's own listings with photo and inquiry counts. */
export async function GET(request: Request) {
  try {
    const user = await requireRole("agent");
    const status = z.enum(LISTING_STATUSES).optional().parse(new URL(request.url).searchParams.get("status") ?? undefined);
    return Response.json({ listings: await listMyListings(user, { status }) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/agent/listings : create a draft. Body: facts plus `clientOpId` (uuid). 201, or 200 when the op id was already used. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("agent");
    const { listing, created } = await createListing(user, await readJson(request));
    return Response.json({ listing }, { status: created ? 201 : 200, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
