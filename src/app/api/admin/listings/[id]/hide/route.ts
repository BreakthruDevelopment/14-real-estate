import { hideListing } from "@/lib/admin";
import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/listings/:id/hide : body `{ hidden: boolean, reason?: string }`. A reason is required to hide. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("admin");
    return Response.json(await hideListing(user, (await ctx.params).id, await readJson(request)));
  } catch (err) {
    return errorResponse(err);
  }
}
