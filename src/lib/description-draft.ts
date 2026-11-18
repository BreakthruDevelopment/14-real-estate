import "server-only";
import { createHash } from "node:crypto";
import { and, count, desc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan } from "@/lib/access";
import { type AiImage } from "@/lib/ai";
import { MAX_DESCRIPTION_PHOTOS, TONES, draftDescription } from "@/lib/ai/listing-description";
import { type Actor } from "@/lib/auth/rbac";
import { type CheckedDraft } from "@/lib/description-checks";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { BadRequestError, TooManyRequestsError } from "@/lib/errors";
import { FEATURE_LABELS, type Feature } from "@/lib/listing-schema";
import { getMyListing, lockAgent } from "@/lib/listings";
import { log } from "@/lib/log";
import { consumeRate, releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";

export const DRAFTS_PER_AGENT_PER_HOUR = 10;
export const DRAFTS_PER_LISTING_PER_DAY = 5;
export const DRAFTS_KEPT_PER_LISTING = 5;

export const draftRequestInput = z.object({
  tone: z.enum(TONES).default("warm"),
  /** Which photos to send (max 3, must belong to this listing). Default: the cover photo. */
  photoIds: z.array(z.string().uuid()).max(MAX_DESCRIPTION_PHOTOS).optional(),
});

export type DescriptionDraftResult = {
  id: string;
  draft: CheckedDraft;
  provider: string;
  demo: boolean;
  /** True when this draft holds wording the save check would refuse. The editor highlights it. */
  blocked: boolean;
};

/**
 * The `md` variants of the chosen photos, as model images. EXIF is already gone (stored variants are re-encoded).
 * PRIVACY (decision D6): free-tier Gemini may use inputs to improve Google's products. The demo workspace therefore
 * uses stock or generated photos only, and the README (14.12) must say so; a real agent's photos go to the model only
 * when the agent asks for a draft, at most 3, as suggestions.
 */
async function loadImages(listingId: string, photoIds: string[]): Promise<{ ids: string[]; images: AiImage[] }> {
  if (photoIds.length === 0) return { ids: [], images: [] };
  const rows = await db()
    .select({ id: schema.photoBlob.photoId, bytes: schema.photoBlob.bytes })
    .from(schema.photoBlob)
    .innerJoin(schema.listingPhoto, eq(schema.listingPhoto.id, schema.photoBlob.photoId))
    .where(and(eq(schema.listingPhoto.listingId, listingId), inArray(schema.photoBlob.photoId, photoIds), eq(schema.photoBlob.variant, "md")));
  const byId = new Map(rows.map((r) => [r.id, r.bytes]));
  const ids = photoIds.filter((id) => byId.has(id));
  return { ids, images: ids.map((id) => ({ mimeType: "image/webp" as const, data: Buffer.from(byId.get(id)!).toString("base64") })) };
}

/**
 * POST /api/agent/listings/[id]/description. Agent-only, own listing (404 otherwise). Nothing is published or saved to
 * the listing: the draft is stored in `description_draft` and returned for the agent to edit and save, and the save is
 * screened again in `listings.ts`.
 */
export async function createDescriptionDraft(actor: Actor | null, rawId: string, input: unknown): Promise<DescriptionDraftResult> {
  assertCan(actor, "listing:manage");
  const req = draftRequestInput.parse(input ?? {});
  const listing = await getMyListing(actor, rawId);

  // Which photos go to the model: the agent's choice (verified to be this listing's), else the cover.
  const own = new Set(listing.photos.map((p) => p.id));
  const wanted = req.photoIds ?? listing.photos.slice(0, 1).map((p) => p.id);
  if (wanted.some((id) => !own.has(id)) || new Set(wanted).size !== wanted.length) {
    throw new BadRequestError("Choose photos that belong to this listing.");
  }
  const { ids: photoIds, images } = await loadImages(listing.id, wanted);

  // Reserve the allowance in one short transaction, never held across the model call.
  const cap = env().AI_DAILY_CAP;
  await db().transaction(async (tx) => {
    await lockAgent(tx, actor);
    await consumeRate(tx, actor.id, "ai", DRAFTS_PER_AGENT_PER_HOUR, "Too many drafts this hour. Try again later.");
    const [{ n }] = await tx
      .select({ n: count() })
      .from(schema.descriptionDraft)
      .where(and(eq(schema.descriptionDraft.listingId, listing.id), gt(schema.descriptionDraft.createdAt, sql`now() - interval '1 day'`)));
    if (n >= DRAFTS_PER_LISTING_PER_DAY) throw new TooManyRequestsError("This listing already has 5 drafts today. Try again tomorrow.");
    if (!(await reserveDaily(tx, "ai", cap))) throw new TooManyRequestsError("The AI writer has reached its daily limit. Try again tomorrow.");
  });

  const facts = {
    propertyType: listing.propertyType,
    beds: listing.beds,
    baths: listing.baths,
    sqft: listing.sqft,
    lotSqft: listing.lotSqft,
    yearBuilt: listing.yearBuilt,
    priceUsd: listing.priceUsd,
    features: listing.features.filter((f): f is Feature => f in FEATURE_LABELS),
    city: listing.city,
    state: listing.state,
    zip: listing.zip,
  };
  let result;
  try {
    result = await draftDescription({ facts, agentNotes: listing.agentNotes, tone: req.tone, photoIds, addressLine: listing.addressLine, images });
  } catch (err) {
    // The model never produced a draft: give the allowance back.
    await db().transaction(async (tx) => {
      await releaseRate(tx, actor.id, "ai");
      await releaseDaily(tx, "ai");
    });
    throw err;
  }

  const factsHash = createHash("sha256").update(JSON.stringify({ facts, n: listing.agentNotes, tone: req.tone, photoIds })).digest("hex");
  const { draft } = result;
  const id = await db().transaction(async (tx) => {
    await lockAgent(tx, actor);
    const [row] = await tx
      .insert(schema.descriptionDraft)
      .values({
        listingId: listing.id,
        agentId: actor.id,
        output: { headline: draft.headline, description: draft.description, highlights: draft.highlights, photoSuggestions: draft.photoSuggestions, needsHumanBecause: draft.needsHumanBecause },
        checks: { flags: draft.flags, dropped: draft.dropped },
        factsHash,
        provider: result.provider,
        demo: result.demo,
      })
      .returning({ id: schema.descriptionDraft.id });
    // Keep the newest five per listing.
    const keep = tx
      .select({ id: schema.descriptionDraft.id })
      .from(schema.descriptionDraft)
      .where(eq(schema.descriptionDraft.listingId, listing.id))
      .orderBy(desc(schema.descriptionDraft.createdAt), desc(schema.descriptionDraft.id))
      .limit(DRAFTS_KEPT_PER_LISTING);
    await tx.delete(schema.descriptionDraft).where(and(eq(schema.descriptionDraft.listingId, listing.id), notInArray(schema.descriptionDraft.id, keep)));
    return row.id;
  });

  // Codes and counts only: never the notes, the text or the images.
  log.info("description.draft", {
    listingId: listing.id,
    demo: result.demo,
    flagCodes: [...new Set(draft.flags.map((f) => f.code))],
    droppedHighlights: draft.dropped.highlights.length,
    droppedPhotoSuggestions: draft.dropped.photoSuggestions.length,
    photos: photoIds.length,
    latencyMs: result.latencyMs,
  });
  return { id, draft, provider: result.provider, demo: result.demo, blocked: draft.flags.some((f) => f.code === "fair_housing") };
}
