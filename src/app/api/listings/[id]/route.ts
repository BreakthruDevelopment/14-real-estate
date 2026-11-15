import { getCurrentUser } from "@/lib/auth/session";
import { NO_STORE, errorResponse } from "@/lib/http";
import { allowPublicRequest, clientIp } from "@/lib/ip-limit";
import { TooManyRequestsError } from "@/lib/errors";
import { getListing } from "@/lib/listings";

export const dynamic = "force-dynamic";

/**
 * GET /api/listings/:id : public while the listing is active and not hidden; the owning agent also gets it in any
 * status (with notes and version). Everyone else, and any missing id, gets 404.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!allowPublicRequest(clientIp(request))) throw new TooManyRequestsError();
    const user = await getCurrentUser();
    return Response.json(await getListing(user, (await ctx.params).id), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
