import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { deleteListing, getMyListing, updateListing } from "@/lib/listings";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/agent/listings/:id : the agent's own listing (any status), with notes, version and photo metadata. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireRole("agent");
    return Response.json({ listing: await getMyListing(user, (await ctx.params).id) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/agent/listings/:id : body: any facts, optional `status`, and the `version` you loaded (stale is 409). */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("agent");
    return Response.json({ listing: await updateListing(user, (await ctx.params).id, await readJson(request)) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/agent/listings/:id : drafts and withdrawn listings only; cascades photos, favorites and inquiries. */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("agent");
    await deleteListing(user, (await ctx.params).id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
