import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { deletePhoto, updatePhoto } from "@/lib/photos";
import { BadRequestError } from "@/lib/errors";
import { jsonHasNul } from "@/lib/text";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; photoId: string }> };

/** PATCH /api/listings/:id/photos/:photoId : body `{ alt?, position? }`. Answers with the listing's photos in their new order. */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("agent");
    const body = await readJson(request);
    if (jsonHasNul(body)) throw new BadRequestError("Text can't contain null characters");
    const { id, photoId } = await ctx.params;
    return Response.json({ photos: await updatePhoto(user, id, photoId, body) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/listings/:id/photos/:photoId : removes the photo and its three stored variants. */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("agent");
    const { id, photoId } = await ctx.params;
    await deletePhoto(user, id, photoId);
    return new Response(null, { status: 204, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
