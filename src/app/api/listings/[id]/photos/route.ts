import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readBodyCapped } from "@/lib/http";
import { BadRequestError } from "@/lib/errors";
import { PHOTO_MAX_BYTES, admitUpload, assertOwnsListing, declaredPhotoType, listPhotos, uploadPhoto } from "@/lib/photos";
import { z } from "zod";

export const dynamic = "force-dynamic";
// Processing is capped at 10 s plus up to 8 s waiting for the one image slot; give the platform room beyond that.
export const maxDuration = 30;

const clientOp = z.string().uuid();

/**
 * POST /api/listings/:id/photos : the raw image as the body (not multipart), `Content-Type` one of image/jpeg,
 * image/png, image/webp, and `x-client-op: <uuid>` (one per intent; a retry with the same id returns the first photo).
 *
 * Refusals, in the order they happen: 401/403 (not an agent), 404 (not your listing), 415 (type), 413 (over 4 MB),
 * 415 (bytes aren't that type), 409 (12 photos, or the site's storage cap), 429 (60 uploads an hour), 422 (can't be
 * read / too many pixels / too detailed), 429 `busy` (one is already waiting), 503 `busy` (too many uploads in flight, or waited too long for a
 * slot), 504 (processing took too long). The last two carry `Retry-After`.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("agent");
    const { id } = await ctx.params;
    // Cheap refusals before the body is read: someone else's listing, a type we don't take, a missing op id.
    await assertOwnsListing(user, id);
    const contentType = request.headers.get("content-type");
    declaredPhotoType(contentType);
    const op = clientOp.safeParse(request.headers.get("x-client-op"));
    if (!op.success) throw new BadRequestError("An x-client-op header with a UUID is required");

    // The slot is taken BEFORE the body is read and held until the answer is decided, so the memory of every body in
    // flight is bounded (503 `busy` when full). Released in `finally`: a throw while reading must not leak it.
    const release = admitUpload();
    try {
      const bytes = await readBodyCapped(request, PHOTO_MAX_BYTES);
      const { photo, created } = await uploadPhoto(user, id, { bytes, contentType, clientOpId: op.data });
      return Response.json({ photo }, { status: created ? 201 : 200, headers: NO_STORE });
    } finally {
      release();
    }
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/listings/:id/photos : the agent's photos on their own listing, in order. Metadata only. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole("agent");
    return Response.json({ photos: await listPhotos(user, (await ctx.params).id) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
