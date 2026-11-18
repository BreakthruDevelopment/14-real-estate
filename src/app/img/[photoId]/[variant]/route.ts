import { getCurrentUser } from "@/lib/auth/session";
import { TooManyRequestsError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { IMG_LIMIT_PER_MINUTE, allowPublicRequest, clientIp } from "@/lib/ip-limit";
import { getPhotoVariant } from "@/lib/photos";

export const dynamic = "force-dynamic";

/**
 * Headers on every image response. The type is always WebP: `getPhotoVariant` refuses bytes that aren't, so the
 * type is never anything stored or supplied by a client. `nosniff` keeps a browser from second-guessing it, and the
 * CSP means that even if something did render this document it could load nothing.
 */
const SAFE = {
  "Content-Type": "image/webp",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'",
} as const;

/** The URL carries `?v=<sha8>` as a cache-buster; it is not checked, because the ETag is the validator. */
const PUBLIC_CACHE = "public, max-age=31536000, immutable";

/**
 * GET /img/:photoId/:variant (`lg`, `md`, `sm`). Public for a photo of an active, not hidden listing; the owning agent
 * alone for anything else; every other case, a missing id included, is the same 404.
 *
 * Its own per-IP namespace (`img`, 600 a minute): a listing page loads up to 36 variants, and they must not spend
 * the `public` allowance that search and the JSON routes share.
 */
export async function GET(request: Request, ctx: { params: Promise<{ photoId: string; variant: string }> }) {
  try {
    if (!allowPublicRequest(clientIp(request), Date.now(), IMG_LIMIT_PER_MINUTE, "img")) {
      throw Object.assign(new TooManyRequestsError(), { retryAfterSeconds: 10 });
    }
    const { photoId, variant } = await ctx.params;
    const served = await getPhotoVariant(getCurrentUser, photoId, variant, request.headers.get("if-none-match"));
    if (served.kind === "not_modified") {
      // A 304 repeats the validators and the cache policy of the 200 it stands for.
      return new Response(null, {
        status: 304,
        headers: { ETag: served.etag, "Cache-Control": PUBLIC_CACHE, "X-Content-Type-Options": "nosniff" },
      });
    }
    const cache: Record<string, string> = served.visibility === "public" ? { ETag: served.etag, "Cache-Control": PUBLIC_CACHE } : { "Cache-Control": "private, no-store" };
    return new Response(new Uint8Array(served.bytes), { status: 200, headers: { ...SAFE, ...cache, "Content-Length": String(served.bytes.byteLength) } });
  } catch (err) {
    // An error is never cacheable: a 404 for a draft must not stick to the URL in a shared cache once it is published.
    const res = errorResponse(err);
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("X-Content-Type-Options", "nosniff");
    return res;
  }
}
