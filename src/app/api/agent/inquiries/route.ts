import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { NO_STORE, errorResponse } from "@/lib/http";
import { listAgentInquiries } from "@/lib/inquiries";
import { INQUIRY_STATUSES } from "@/lib/listing-schema";

export const dynamic = "force-dynamic";

/** GET /api/agent/inquiries?status=&listingId= : inquiries on the agent's own listings, with the buyer's name and email. */
export async function GET(request: Request) {
  try {
    const user = await requireRole("agent");
    const p = new URL(request.url).searchParams;
    const query = z
      .object({ status: z.enum(INQUIRY_STATUSES).optional(), listingId: z.string().optional() })
      .parse({ status: p.get("status") ?? undefined, listingId: p.get("listingId") ?? undefined });
    return Response.json({ inquiries: await listAgentInquiries(user, query) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
