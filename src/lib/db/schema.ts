import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Domain tables (spec 14, "Data model"). Access rules live in src/lib/access.ts; every query that returns
// listings selects explicit columns, so `embedding`, `tsv` and `embed_hash` never reach a response.
// ---------------------------------------------------------------------------

export const PROPERTY_TYPES = ["house", "condo", "townhouse", "multi_family", "land"] as const;
export const LISTING_STATUSES = ["draft", "active", "pending", "sold", "withdrawn"] as const;
export const GEO_SOURCES = ["zip", "device", "manual"] as const;
export const PHOTO_VARIANTS = ["lg", "md", "sm"] as const;
export const INQUIRY_STATUSES = ["open", "contacted", "closed"] as const;
export const EMBED_DIMS = 768;
/** A stored photo variant may not exceed this (spec: `bytes` bytea at most 400 KB). */
export const PHOTO_VARIANT_MAX_BYTES = 400 * 1024;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** Postgres `bytea` as a Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** Postgres `tsvector`; only ever a generated column, never written. */
const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

export const listing = pgTable(
  "listing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Owner. `restrict`: nothing deletes users (Better Auth's remove-user is disabled), so listings never orphan. */
    agentId: text("agent_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    propertyType: text("property_type", { enum: PROPERTY_TYPES }).notNull(),
    status: text("status", { enum: LISTING_STATUSES }).notNull().default("draft"),
    priceUsd: integer("price_usd").notNull(),
    beds: integer("beds").notNull(),
    baths: numeric("baths", { precision: 3, scale: 1, mode: "number" }).notNull(),
    sqft: integer("sqft"),
    lotSqft: integer("lot_sqft"),
    yearBuilt: integer("year_built"),
    features: text("features").array().notNull().default(sql`'{}'::text[]`),
    addressLine: text("address_line").notNull(),
    city: text("city").notNull(),
    state: text("state").notNull(),
    zip: text("zip").notNull(),
    lat: numeric("lat", { precision: 8, scale: 5, mode: "number" }),
    lng: numeric("lng", { precision: 8, scale: 5, mode: "number" }),
    geoSource: text("geo_source", { enum: GEO_SOURCES }),
    description: text("description").notNull().default(""),
    /** Never public. */
    agentNotes: text("agent_notes").notNull().default(""),
    /** Maintained by the search module (14.6): title, type, city, ZIP, features, description. No street number, no agent data. */
    searchText: text("search_text").notNull().default(""),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', search_text)`),
    embedding: vector("embedding", { dimensions: EMBED_DIMS }),
    embeddingModel: text("embedding_model"),
    embedHash: text("embed_hash"),
    /** Hidden by an admin (a reason is required) or by revoking the agent (`agent_revoked`). Hidden listings 404 publicly. */
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    hiddenReason: text("hidden_reason"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    clientOpId: uuid("client_op_id"),
    /** Optimistic locking: every update must name the version it read; a stale one is a 409. */
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("listing_agent_client_op_uidx").on(t.agentId, t.clientOpId),
    index("listing_agent_status_idx").on(t.agentId, t.status),
    index("listing_status_geo_idx").on(t.status, t.lat, t.lng),
    index("listing_tsv_idx").using("gin", t.tsv),
    check("listing_property_type_chk", sql`${t.propertyType} in (${list(PROPERTY_TYPES)})`),
    check("listing_status_chk", sql`${t.status} in (${list(LISTING_STATUSES)})`),
    check("listing_geo_source_chk", sql`${t.geoSource} is null or ${t.geoSource} in (${list(GEO_SOURCES)})`),
    check("listing_title_chk", sql`char_length(${t.title}) between 1 and 100`),
    check("listing_price_chk", sql`${t.priceUsd} between 1000 and 100000000`),
    check("listing_beds_chk", sql`${t.beds} between 0 and 20`),
    check("listing_baths_chk", sql`${t.baths} between 0 and 20`),
    check("listing_sqft_chk", sql`${t.sqft} is null or ${t.sqft} between 100 and 100000`),
    check("listing_lot_chk", sql`${t.lotSqft} is null or ${t.lotSqft} between 100 and 1000000000`),
    check("listing_year_chk", sql`${t.yearBuilt} is null or ${t.yearBuilt} between 1800 and 2027`),
    check("listing_features_chk", sql`cardinality(${t.features}) <= 20`),
    check("listing_address_chk", sql`char_length(${t.addressLine}) between 1 and 200 and char_length(${t.city}) between 1 and 80`),
    check("listing_state_zip_chk", sql`${t.state} ~ '^[A-Z]{2}$' and ${t.zip} ~ '^[0-9]{5}$'`),
    check("listing_geo_chk", sql`(${t.lat} is null) = (${t.lng} is null) and (${t.lat} is null) = (${t.geoSource} is null)`),
    check("listing_bounds_chk", sql`${t.lat} is null or (${t.lat} between 17.5 and 71.5 and ${t.lng} between -179 and -64)`),
    check("listing_description_chk", sql`char_length(${t.description}) <= 3000 and char_length(${t.agentNotes}) <= 1000`),
    check("listing_hidden_chk", sql`(${t.hiddenAt} is null) = (${t.hiddenReason} is null)`),
    check("listing_hidden_reason_chk", sql`${t.hiddenReason} is null or char_length(${t.hiddenReason}) between 1 and 200`),
    check("listing_version_chk", sql`${t.version} >= 1`),
  ],
);

export const listingPhoto = pgTable(
  "listing_photo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listing.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    alt: text("alt").notNull().default(""),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytesTotal: integer("bytes_total").notNull(),
    sha256: text("sha256").notNull(),
    clientOpId: uuid("client_op_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("listing_photo_client_op_uidx").on(t.listingId, t.clientOpId),
    // The generated SQL is edited by hand to add DEFERRABLE INITIALLY DEFERRED, so a reorder can swap positions in one statement.
    unique("listing_photo_position_uq").on(t.listingId, t.position),
    check("listing_photo_position_chk", sql`${t.position} >= 0`),
    check("listing_photo_alt_chk", sql`char_length(${t.alt}) <= 150`),
    check("listing_photo_size_chk", sql`${t.width} > 0 and ${t.height} > 0 and ${t.bytesTotal} >= 0`),
  ],
);

/** Photo bytes. Only the image route reads `bytes`; every other query leaves the column out. */
export const photoBlob = pgTable(
  "photo_blob",
  {
    photoId: uuid("photo_id")
      .notNull()
      .references(() => listingPhoto.id, { onDelete: "cascade" }),
    variant: text("variant", { enum: PHOTO_VARIANTS }).notNull(),
    bytes: bytea("bytes").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.photoId, t.variant] }),
    check("photo_blob_variant_chk", sql`${t.variant} in (${list(PHOTO_VARIANTS)})`),
    check("photo_blob_bytes_chk", sql`octet_length(${t.bytes}) <= ${sql.raw(String(PHOTO_VARIANT_MAX_BYTES))}`),
  ],
);

/** Approximate ZIP-code centroids (USPS ZIPs, GeoNames-derived data, CC BY 3.0; see data/README.md), loaded once by the 14.3 loader. Public. */
export const zipCentroid = pgTable(
  "zip_centroid",
  {
    zip: text("zip").primaryKey(),
    lat: numeric("lat", { precision: 8, scale: 5, mode: "number" }).notNull(),
    lng: numeric("lng", { precision: 8, scale: 5, mode: "number" }).notNull(),
  },
  (t) => [check("zip_centroid_zip_chk", sql`${t.zip} ~ '^[0-9]{5}$'`)],
);

export const favorite = pgTable(
  "favorite",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listing.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.listingId] }), index("favorite_listing_idx").on(t.listingId)],
);

export const inquiry = pgTable(
  "inquiry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listing.id, { onDelete: "cascade" }),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    message: text("message").notNull(),
    status: text("status", { enum: INQUIRY_STATUSES }).notNull().default("open"),
    clientOpId: uuid("client_op_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inquiry_buyer_client_op_uidx").on(t.buyerId, t.clientOpId),
    uniqueIndex("inquiry_one_open_uidx").on(t.buyerId, t.listingId).where(sql`${t.status} = 'open'`),
    index("inquiry_listing_idx").on(t.listingId, t.status),
    check("inquiry_status_chk", sql`${t.status} in (${list(INQUIRY_STATUSES)})`),
    check("inquiry_message_chk", sql`char_length(${t.message}) between 1 and 1000`),
  ],
);

/** AI description drafts (written by 14.5); the last 5 per listing are kept. */
export const descriptionDraft = pgTable(
  "description_draft",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listing.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    output: jsonb("output").$type<Record<string, unknown>>().notNull(),
    /** Flags and dropped items from the server-side checks. */
    checks: jsonb("checks").$type<Record<string, unknown>>().notNull(),
    factsHash: text("facts_hash").notNull(),
    provider: text("provider").notNull(),
    demo: boolean("demo").notNull().default(false),
    /** One id per request intent (`x-client-op`). A retry with the same id gets the first draft, never a second model call. */
    clientOpId: uuid("client_op_id").notNull(),
    /**
     * `pending` is a slot reserved BEFORE the model call (it counts toward the per-listing daily cap, so concurrent requests
     * can't overshoot it); `done` holds the draft. A pending row older than a minute is abandoned and may be replaced.
     */
    status: text("status", { enum: ["pending", "done"] }).notNull().default("done"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("description_draft_listing_idx").on(t.listingId, t.createdAt),
    uniqueIndex("description_draft_client_op_uidx").on(t.listingId, t.clientOpId),
    check("description_draft_status_chk", sql`${t.status} in ('pending', 'done')`),
  ],
);

/** Cache of search-query embeddings, keyed by sha256(model + normalised text). No query text is stored. Pruned at 7 days. */
export const queryEmbedding = pgTable("query_embedding", {
  key: text("key").primaryKey(),
  model: text("model").notNull(),
  embedding: vector("embedding", { dimensions: EMBED_DIMS }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Each app lists its own kinds here; changing a list
// needs a migration, because the CHECK constraints below are part of the schema.
// ---------------------------------------------------------------------------

export const RATE_KINDS = ["api_write", "ai", "photo_upload", "inquiry"] as const;
export const DAILY_USAGE_KINDS = ["ai", "demo_load", "embed_doc", "embed_query"] as const;

/** App-wide daily counters (one row per UTC day and kind) for free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/**
 * Background job queue (see src/lib/jobs). `key` makes enqueue idempotent: only one queued or running job per
 * (kind, key). `payload` holds ids and small parameters, never personal data or secrets. `last_error` is a short
 * code, never a message.
 */
export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    key: text("key"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    /** Times a handler asked to try again later without using an attempt; capped so a job can't defer forever. */
    deferrals: integer("deferrals").notNull().default(0),
    /** A floor, not a deadline: the job runs at the first claim after this time. */
    runAfter: timestamp("run_after", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** While running: the lease. After it passes, any worker may reclaim the job. */
    lockedUntil: timestamp("locked_until", { withTimezone: true, precision: 3 }),
    /** Fencing token of the current claim: a worker whose lease was reclaimed can no longer complete or fail the job. */
    lockToken: uuid("lock_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    uniqueIndex("job_active_key_uidx").on(t.kind, t.key).where(sql`${t.status} in ('queued', 'running') and ${t.key} is not null`),
    index("job_due_idx").on(t.runAfter).where(sql`${t.status} = 'queued'`),
    index("job_lease_idx").on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    index("job_kind_key_idx").on(t.kind, t.key, t.createdAt),
    index("job_owner_idx").on(t.ownerId),
    check("job_status_chk", sql`${t.status} in (${list(JOB_STATUSES)})`),
    check("job_attempts_chk", sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1 and ${t.deferrals} >= 0`),
  ],
);

export type User = typeof user.$inferSelect;
export type ListingRow = typeof listing.$inferSelect;
export type InquiryRow = typeof inquiry.$inferSelect;
export type Job = typeof job.$inferSelect;
