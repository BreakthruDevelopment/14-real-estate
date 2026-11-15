import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { setListingLocation } from "@/lib/listings";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/listings/:id/location : body `{ source: "zip" | "device" | "manual", version, lat?, lng?, accuracyM?, confirmFar? }`.
 * A device location more than 5 mi from the ZIP's centre is refused (422); typed coordinates that far need `confirmFar: true`.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("agent");
    return Response.json({ listing: await setListingLocation(user, (await ctx.params).id, await readJson(request)) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
