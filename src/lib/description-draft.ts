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
import { BadRequestError, ConflictError, TooManyRequestsError } from "@/lib/errors";
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
  /** True when this is the answer to an earlier request with the same `x-client-op` (no new model call was made). */
  replayed: boolean;
};

/** A reserved slot older than this is an abandoned request (the process died); a retry may replace it. */
export const PENDING_STALE_MS = 60_000;
const WAIT_STEP_MS = 200;
const WAIT_MAX_MS = 22_000;

const D = schema.descriptionDraft;

type Claim = { kind: "replay"; result: DescriptionDraftResult } | { kind: "wait" } | { kind: "new"; id: string };

function replayOf(row: typeof D.$inferSelect): DescriptionDraftResult {
  const output = row.output as unknown as Omit<CheckedDraft, "flags" | "dropped">;
  const checks = row.checks as unknown as Pick<CheckedDraft, "flags" | "dropped">;
  const draft: CheckedDraft = { ...output, flags: checks.flags, dropped: checks.dropped };
  return { id: row.id, draft, provider: row.provider, demo: row.demo, blocked: draft.flags.some((f) => f.code === "fair_housing"), replayed: true };
}

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
 *
 * Idempotent per (listing, `clientOpId`): a retry gets the FIRST answer (`replayed: true`) with no new model call and no
 * new allowance used, including a retry that arrives while the first request is still running (it waits for it). The slot
 * is reserved in the database BEFORE the model call, in one transaction under the agent's write lock, so neither this
 * listing's 5-a-day cap nor the 10-an-hour and app-wide caps can be overshot by concurrent requests; a failed model call
 * gives the slot and the allowance back.
 */
export async function createDescriptionDraft(actor: Actor | null, rawId: string, input: unknown, clientOpId: string): Promise<DescriptionDraftResult> {
  assertCan(actor, "listing:manage");
  const req = draftRequestInput.parse(input ?? {});
  const opId = z.string().uuid().parse(clientOpId);
  const listing = await getMyListing(actor, rawId);

  // Which photos go to the model: the agent's choice (verified to be this listing's), else the cover.
  const own = new Set(listing.photos.map((p) => p.id));
  const wanted = req.photoIds ?? listing.photos.slice(0, 1).map((p) => p.id);
  if (wanted.some((id) => !own.has(id)) || new Set(wanted).size !== wanted.length) {
    throw new BadRequestError("Choose photos that belong to this listing.");
  }

  const cap = env().AI_DAILY_CAP;
  const claim = (): Promise<Claim> =>
    db().transaction(async (tx) => {
      await lockAgent(tx, actor);
      const [existing] = await tx.select().from(D).where(and(eq(D.listingId, listing.id), eq(D.clientOpId, opId)));
      if (existing) {
        if (existing.status === "done") return { kind: "replay", result: replayOf(existing) };
        if (Date.now() - existing.createdAt.getTime() <= PENDING_STALE_MS) return { kind: "wait" };
        await tx.delete(D).where(eq(D.id, existing.id)); // abandoned: take it over (its allowance stays spent)
      }
      const [{ n }] = await tx
        .select({ n: count() })
        .from(D)
        .where(and(eq(D.listingId, listing.id), gt(D.createdAt, sql`now() - interval '1 day'`)));
      if (n >= DRAFTS_PER_LISTING_PER_DAY) throw new TooManyRequestsError("This listing already has 5 drafts today. Try again tomorrow.");
      await consumeRate(tx, actor.id, "ai", DRAFTS_PER_AGENT_PER_HOUR, "Too many drafts this hour. Try again later.");
      if (!(await reserveDaily(tx, "ai", cap))) throw new TooManyRequestsError("The AI writer has reached its daily limit. Try again tomorrow.");
      const [row] = await tx
        .insert(D)
        .values({ listingId: listing.id, agentId: actor.id, output: {}, checks: {}, factsHash: "", provider: "", demo: false, clientOpId: opId, status: "pending" })
        .returning({ id: D.id });
      return { kind: "new", id: row.id };
    });

  // A duplicate that arrives while the first is still running waits for its answer instead of making a second call.
  const waitUntil = Date.now() + WAIT_MAX_MS;
  let claimed = await claim();
  while (claimed.kind === "wait") {
    if (Date.now() > waitUntil) throw new ConflictError("This draft is still being written. Retry in a moment with the same request id.");
    await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
    claimed = await claim();
  }
  if (claimed.kind === "replay") return claimed.result;
  const draftId = claimed.id;

  // From here the slot is ours: any failure before the draft is stored gives it back.
  const giveBack = () =>
    db().transaction(async (tx) => {
      await lockAgent(tx, actor);
      await tx.delete(D).where(and(eq(D.id, draftId), eq(D.status, "pending")));
      await releaseRate(tx, actor.id, "ai");
      await releaseDaily(tx, "ai");
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
  let photoIds: string[];
  let result;
  try {
    const loaded = await loadImages(listing.id, wanted);
    photoIds = loaded.ids;
    result = await draftDescription({ facts, agentNotes: listing.agentNotes, tone: req.tone, photoIds, addressLine: listing.addressLine, images: loaded.images });
  } catch (err) {
    await giveBack();
    throw err;
  }

  const factsHash = createHash("sha256").update(JSON.stringify({ facts, n: listing.agentNotes, tone: req.tone, photoIds })).digest("hex");
  const { draft } = result;
  try {
    await db().transaction(async (tx) => {
      await lockAgent(tx, actor);
      await tx
        .update(D)
        .set({
          output: { headline: draft.headline, description: draft.description, highlights: draft.highlights, photoSuggestions: draft.photoSuggestions, needsHumanBecause: draft.needsHumanBecause },
          checks: { flags: draft.flags, dropped: draft.dropped },
          factsHash,
          provider: result.provider,
          demo: result.demo,
          status: "done",
        })
        .where(eq(D.id, draftId));
      // Keep the newest five per listing.
      const keep = tx.select({ id: D.id }).from(D).where(eq(D.listingId, listing.id)).orderBy(desc(D.createdAt), desc(D.id)).limit(DRAFTS_KEPT_PER_LISTING);
      await tx.delete(D).where(and(eq(D.listingId, listing.id), notInArray(D.id, keep)));
    });
  } catch (err) {
    await giveBack();
    throw err;
  }

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
  return { id: draftId, draft, provider: result.provider, demo: result.demo, blocked: draft.flags.some((f) => f.code === "fair_housing"), replayed: false };
}
