ALTER TABLE "bundle_blobs" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bundle_blobs_user_id_id_key" ON "bundle_blobs" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "bundles" ADD COLUMN "blob_id" uuid NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bundles_blob_id_key" ON "bundles" USING btree ("blob_id");--> statement-breakpoint
-- Reordered by hand: the foreign key needs the unique index on bundle_blobs (user_id, id) first.
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_blob_fk" FOREIGN KEY ("user_id","blob_id") REFERENCES "public"."bundle_blobs"("user_id","id") ON DELETE no action ON UPDATE no action;
