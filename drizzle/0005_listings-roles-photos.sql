CREATE TABLE "description_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"output" jsonb NOT NULL,
	"checks" jsonb NOT NULL,
	"facts_hash" text NOT NULL,
	"provider" text NOT NULL,
	"demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorite" (
	"user_id" text NOT NULL,
	"listing_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorite_user_id_listing_id_pk" PRIMARY KEY("user_id","listing_id")
);
--> statement-breakpoint
CREATE TABLE "inquiry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"buyer_id" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"client_op_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inquiry_status_chk" CHECK ("inquiry"."status" in ('open', 'contacted', 'closed')),
	CONSTRAINT "inquiry_message_chk" CHECK (char_length("inquiry"."message") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "listing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"title" text NOT NULL,
	"property_type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"price_usd" integer NOT NULL,
	"beds" integer NOT NULL,
	"baths" numeric(3, 1) NOT NULL,
	"sqft" integer,
	"lot_sqft" integer,
	"year_built" integer,
	"features" text[] DEFAULT '{}'::text[] NOT NULL,
	"address_line" text NOT NULL,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"zip" text NOT NULL,
	"lat" numeric(8, 5),
	"lng" numeric(8, 5),
	"geo_source" text,
	"description" text DEFAULT '' NOT NULL,
	"agent_notes" text DEFAULT '' NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED,
	"embedding" vector(768),
	"embedding_model" text,
	"embed_hash" text,
	"hidden_at" timestamp with time zone,
	"hidden_reason" text,
	"published_at" timestamp with time zone,
	"client_op_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_property_type_chk" CHECK ("listing"."property_type" in ('house', 'condo', 'townhouse', 'multi_family', 'land')),
	CONSTRAINT "listing_status_chk" CHECK ("listing"."status" in ('draft', 'active', 'pending', 'sold', 'withdrawn')),
	CONSTRAINT "listing_geo_source_chk" CHECK ("listing"."geo_source" is null or "listing"."geo_source" in ('zip', 'device', 'manual')),
	CONSTRAINT "listing_title_chk" CHECK (char_length("listing"."title") between 1 and 100),
	CONSTRAINT "listing_price_chk" CHECK ("listing"."price_usd" between 1000 and 100000000),
	CONSTRAINT "listing_beds_chk" CHECK ("listing"."beds" between 0 and 20),
	CONSTRAINT "listing_baths_chk" CHECK ("listing"."baths" between 0 and 20),
	CONSTRAINT "listing_sqft_chk" CHECK ("listing"."sqft" is null or "listing"."sqft" between 100 and 100000),
	CONSTRAINT "listing_lot_chk" CHECK ("listing"."lot_sqft" is null or "listing"."lot_sqft" between 100 and 1000000000),
	CONSTRAINT "listing_year_chk" CHECK ("listing"."year_built" is null or "listing"."year_built" between 1800 and 2027),
	CONSTRAINT "listing_features_chk" CHECK (cardinality("listing"."features") <= 20),
	CONSTRAINT "listing_address_chk" CHECK (char_length("listing"."address_line") between 1 and 200 and char_length("listing"."city") between 1 and 80),
	CONSTRAINT "listing_state_zip_chk" CHECK ("listing"."state" ~ '^[A-Z]{2}$' and "listing"."zip" ~ '^[0-9]{5}$'),
	CONSTRAINT "listing_geo_chk" CHECK (("listing"."lat" is null) = ("listing"."lng" is null) and ("listing"."lat" is null) = ("listing"."geo_source" is null)),
	CONSTRAINT "listing_bounds_chk" CHECK ("listing"."lat" is null or ("listing"."lat" between 17.5 and 71.5 and "listing"."lng" between -179 and -64)),
	CONSTRAINT "listing_description_chk" CHECK (char_length("listing"."description") <= 3000 and char_length("listing"."agent_notes") <= 1000),
	CONSTRAINT "listing_hidden_chk" CHECK (("listing"."hidden_at" is null) = ("listing"."hidden_reason" is null)),
	CONSTRAINT "listing_hidden_reason_chk" CHECK ("listing"."hidden_reason" is null or char_length("listing"."hidden_reason") between 1 and 200),
	CONSTRAINT "listing_version_chk" CHECK ("listing"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "listing_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"alt" text DEFAULT '' NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes_total" integer NOT NULL,
	"sha256" text NOT NULL,
	"client_op_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_photo_position_uq" UNIQUE("listing_id","position") DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "listing_photo_position_chk" CHECK ("listing_photo"."position" >= 0),
	CONSTRAINT "listing_photo_alt_chk" CHECK (char_length("listing_photo"."alt") <= 150),
	CONSTRAINT "listing_photo_size_chk" CHECK ("listing_photo"."width" > 0 and "listing_photo"."height" > 0 and "listing_photo"."bytes_total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "photo_blob" (
	"photo_id" uuid NOT NULL,
	"variant" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	CONSTRAINT "photo_blob_photo_id_variant_pk" PRIMARY KEY("photo_id","variant"),
	CONSTRAINT "photo_blob_variant_chk" CHECK ("photo_blob"."variant" in ('lg', 'md', 'sm')),
	CONSTRAINT "photo_blob_bytes_chk" CHECK (octet_length("photo_blob"."bytes") <= 409600)
);
--> statement-breakpoint
CREATE TABLE "query_embedding" (
	"key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zip_centroid" (
	"zip" text PRIMARY KEY NOT NULL,
	"lat" numeric(8, 5) NOT NULL,
	"lng" numeric(8, 5) NOT NULL,
	CONSTRAINT "zip_centroid_zip_chk" CHECK ("zip_centroid"."zip" ~ '^[0-9]{5}$')
);
--> statement-breakpoint
ALTER TABLE "daily_usage" DROP CONSTRAINT "daily_usage_kind_chk";--> statement-breakpoint
ALTER TABLE "rate_event" DROP CONSTRAINT "rate_event_kind_chk";--> statement-breakpoint
-- The template's `upload` rate kind is `photo_upload` in this app; carry existing rows over before the new check.
UPDATE "rate_event" SET "kind" = 'photo_upload' WHERE "kind" = 'upload';--> statement-breakpoint
-- The example `item` table is replaced by the listing tables (nothing references it).
DROP TABLE "item";--> statement-breakpoint
ALTER TABLE "description_draft" ADD CONSTRAINT "description_draft_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "description_draft" ADD CONSTRAINT "description_draft_agent_id_user_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorite" ADD CONSTRAINT "favorite_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorite" ADD CONSTRAINT "favorite_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_buyer_id_user_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing" ADD CONSTRAINT "listing_agent_id_user_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_photo" ADD CONSTRAINT "listing_photo_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_blob" ADD CONSTRAINT "photo_blob_photo_id_listing_photo_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."listing_photo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "description_draft_listing_idx" ON "description_draft" USING btree ("listing_id","created_at");--> statement-breakpoint
CREATE INDEX "favorite_listing_idx" ON "favorite" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inquiry_buyer_client_op_uidx" ON "inquiry" USING btree ("buyer_id","client_op_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inquiry_one_open_uidx" ON "inquiry" USING btree ("buyer_id","listing_id") WHERE "inquiry"."status" = 'open';--> statement-breakpoint
CREATE INDEX "inquiry_listing_idx" ON "inquiry" USING btree ("listing_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_agent_client_op_uidx" ON "listing" USING btree ("agent_id","client_op_id");--> statement-breakpoint
CREATE INDEX "listing_agent_status_idx" ON "listing" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "listing_status_geo_idx" ON "listing" USING btree ("status","lat","lng");--> statement-breakpoint
CREATE INDEX "listing_tsv_idx" ON "listing" USING gin ("tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_photo_client_op_uidx" ON "listing_photo" USING btree ("listing_id","client_op_id");--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_kind_chk" CHECK ("daily_usage"."kind" in ('ai', 'demo_load', 'embed_doc', 'embed_query'));--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('api_write', 'ai', 'photo_upload', 'inquiry'));