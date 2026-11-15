import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { createInquiry, listMyInquiries } from "@/lib/inquiries";

export const dynamic = "force-dynamic";

/** GET /api/inquiries : the buyer's own inquiries. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ inquiries: await listMyInquiries(user) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/inquiries : body `{ listingId, message, clientOpId }`. 201, or 200 for a replayed `clientOpId`. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { inquiry, created } = await createInquiry(user, await readJson(request));
    return Response.json({ inquiry }, { status: created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
