ALTER TABLE "description_draft" ADD COLUMN "client_op_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "description_draft" ADD COLUMN "status" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "description_draft_client_op_uidx" ON "description_draft" USING btree ("listing_id","client_op_id");--> statement-breakpoint
ALTER TABLE "description_draft" ADD CONSTRAINT "description_draft_status_chk" CHECK ("description_draft"."status" in ('pending', 'done'));