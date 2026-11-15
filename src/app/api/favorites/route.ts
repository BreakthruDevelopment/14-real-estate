import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { addFavorite, listFavorites, removeFavorite } from "@/lib/favorites";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const body = z.object({ listingId: z.string().uuid() });

/** GET /api/favorites : the buyer's favorites that are still public. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ favorites: await listFavorites(user) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/favorites : body `{ listingId }`. Idempotent. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { listingId } = body.parse(await readJson(request));
    const result = await addFavorite(user, listingId);
    return Response.json(result, { status: result.added ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/favorites?listingId= */
export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const listingId = new URL(request.url).searchParams.get("listingId") ?? "";
    await removeFavorite(user, listingId);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
