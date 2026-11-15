/**
 * Listing constants and zod schemas. Pure (no database, no `server-only`), so the editor forms can reuse the same
 * limits as the data layer. The data layer (`listings.ts`) parses every input with these; the database CHECK
 * constraints in `src/lib/db/schema.ts` are the second layer.
 */
import { z } from "zod";
import { text } from "@/lib/text";

export const PROPERTY_TYPES = ["house", "condo", "townhouse", "multi_family", "land"] as const;
export const LISTING_STATUSES = ["draft", "active", "pending", "sold", "withdrawn"] as const;
export const INQUIRY_STATUSES = ["open", "contacted", "closed"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** The fixed feature checklist (spec: "features text[] <=20 from a fixed list"). Keys are stored; labels are shown. */
export const FEATURE_LABELS = {
  fenced_yard: "Fenced yard",
  home_office: "Home office",
  garage: "Garage",
  pool: "Pool",
  fireplace: "Fireplace",
  central_air: "Central air",
  hardwood_floors: "Hardwood floors",
  updated_kitchen: "Updated kitchen",
  finished_basement: "Finished basement",
  solar_panels: "Solar panels",
  covered_porch: "Covered porch",
  walk_in_closet: "Walk-in closet",
  laundry_room: "Laundry room",
  smart_home: "Smart-home wiring",
  ev_charger: "EV charger",
  waterfront: "Waterfront",
  new_roof: "New roof",
  corner_lot: "Corner lot",
  mountain_view: "Mountain view",
  accessible_entry: "Step-free entry",
} as const;
export type Feature = keyof typeof FEATURE_LABELS;
export const FEATURES = Object.keys(FEATURE_LABELS) as [Feature, ...Feature[]];

/** Which status an agent may move a listing to. Publishing (to `active`) has extra checks, see `publishBlockers`. */
export const STATUS_TRANSITIONS: Record<ListingStatus, readonly ListingStatus[]> = {
  draft: ["active"],
  active: ["pending", "sold", "withdrawn"],
  pending: ["active", "sold", "withdrawn"],
  sold: ["active"],
  withdrawn: ["active"],
};

export const LIMITS = {
  listingsPerAgent: 50,
  listingsApp: 5000,
  writesPerHour: 300,
  photosPerListing: 12,
  favoritesPerUser: 200,
  inquiriesPerHour: 5,
  inquiriesPerDay: 20,
  minDescriptionToPublish: 200,
} as const;

/** Where a location may be (US including Alaska, Hawaii and Puerto Rico; no antimeridian case). */
export const GEO_BOUNDS = { latMin: 17.5, latMax: 71.5, lngMin: -179.0, lngMax: -64.0 } as const;
/** A device or typed location farther than this from the listing ZIP's centroid is refused or needs a confirm. */
export const FAR_MILES = 5;
export const DEVICE_MAX_ACCURACY_M = 200;

const oneDecimal = (n: number) => Math.round(n * 10) / 10 === n;

/** Every editable fact. No defaults here: `.partial()` of a defaulted field would overwrite stored values on update. */
const facts = {
  title: text(100, { min: 1, minMessage: "Title is required" }),
  propertyType: z.enum(PROPERTY_TYPES),
  priceUsd: z.number().int().min(1_000).max(100_000_000),
  beds: z.number().int().min(0).max(20),
  baths: z.number().min(0).max(20).refine(oneDecimal, "Baths take at most one decimal"),
  sqft: z.number().int().min(100).max(100_000).nullable(),
  lotSqft: z.number().int().min(100).max(1_000_000_000).nullable(),
  yearBuilt: z.number().int().min(1800).max(2027).nullable(),
  features: z
    .array(z.enum(FEATURES))
    .max(20)
    .transform((f) => [...new Set(f)]),
  addressLine: text(200, { min: 1, minMessage: "Address is required" }),
  city: text(80, { min: 1, minMessage: "City is required" }),
  state: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Use the two-letter state code"),
  zip: z
    .string()
    .trim()
    .regex(/^\d{5}$/, "ZIP must be 5 digits"),
  description: text(3000),
  agentNotes: text(1000),
};

const clientOpId = z.string().uuid();

export const newListingInput = z.object({
  title: facts.title,
  propertyType: facts.propertyType,
  priceUsd: facts.priceUsd,
  beds: facts.beds,
  baths: facts.baths,
  sqft: facts.sqft.optional().transform((v) => v ?? null),
  lotSqft: facts.lotSqft.optional().transform((v) => v ?? null),
  yearBuilt: facts.yearBuilt.optional().transform((v) => v ?? null),
  features: facts.features.optional().transform((v) => v ?? []),
  addressLine: facts.addressLine,
  city: facts.city,
  state: facts.state,
  zip: facts.zip,
  description: facts.description.optional().transform((v) => v ?? ""),
  agentNotes: facts.agentNotes.optional().transform((v) => v ?? ""),
  /** One id per user intent (see src/lib/client-op.ts); a retry with the same id returns the first listing. */
  clientOpId,
});
export type NewListingInput = z.input<typeof newListingInput>;

export const updateListingInput = z
  .object(facts)
  .partial()
  .extend({
    /** The version the editor loaded. A stale one is a 409. */
    version: z.number().int().min(1),
    status: z.enum(LISTING_STATUSES).optional(),
  })
  .refine((v) => Object.entries(v).some(([k, val]) => k !== "version" && val !== undefined), "Nothing to change");
export type UpdateListingInput = z.input<typeof updateListingInput>;

const lat = z.number().min(GEO_BOUNDS.latMin).max(GEO_BOUNDS.latMax);
const lng = z.number().min(GEO_BOUNDS.lngMin).max(GEO_BOUNDS.lngMax);

export const locationInput = z.discriminatedUnion("source", [
  z.object({ source: z.literal("zip"), version: z.number().int().min(1) }),
  z.object({
    source: z.literal("device"),
    version: z.number().int().min(1),
    lat,
    lng,
    accuracyM: z.number().min(0).max(DEVICE_MAX_ACCURACY_M, "Location accuracy is worse than 200 m: move outdoors or enter coordinates"),
  }),
  z.object({
    source: z.literal("manual"),
    version: z.number().int().min(1),
    lat,
    lng,
    /** Needed (from a second click) when the point is more than 5 miles from the ZIP's centre. */
    confirmFar: z.boolean().optional(),
  }),
]);
export type LocationInput = z.input<typeof locationInput>;

export const inquiryInput = z.object({
  listingId: z.string().uuid(),
  message: text(1000, { min: 1, minMessage: "Write a message" }),
  clientOpId,
});

export const inquiryStatusInput = z.object({ status: z.enum(INQUIRY_STATUSES) });

/** The reason `setUserRole` stamps on listings it hides; an admin can't use it as a hide reason. */
export const AGENT_REVOKED = "agent_revoked";

export const hideInput = z
  .object({ hidden: z.boolean(), reason: text(200).optional() })
  .refine((v) => !v.hidden || (v.reason && v.reason.length > 0), "A reason is required to hide a listing")
  .refine((v) => v.reason?.toLowerCase() !== AGENT_REVOKED, "That reason is reserved");

export const roleInput = z.object({
  userId: text(200, { min: 1 }),
  role: z.enum(["user", "agent"]),
});
