import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { updateInquiryStatus } from "@/lib/inquiries";

export const dynamic = "force-dynamic";

/** PATCH /api/agent/inquiries/:id : body `{ status: "open" | "contacted" | "closed" }`. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("agent");
    return Response.json({ inquiry: await updateInquiryStatus(user, (await ctx.params).id, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}
