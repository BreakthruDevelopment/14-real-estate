import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { createDescriptionDraft } from "@/lib/description-draft";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * POST /api/agent/listings/:id/description : body (send `{}` for the defaults) `{ tone?: "warm" | "concise" | "luxury", photoIds?: uuid[] (max 3) }`.
 * Returns an AI draft with the server's checks (flags, dropped items). It is a draft only: nothing is saved to the
 * listing, and saving the text goes through PATCH, which refuses wording the fair-housing screen flags.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("agent");
    return Response.json(await createDescriptionDraft(user, (await ctx.params).id, await readJson(request)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
