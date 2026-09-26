ALTER TABLE "bundle_blobs" DROP CONSTRAINT "bundle_blobs_revision_positive";--> statement-breakpoint
ALTER TABLE "bundles" DROP CONSTRAINT "bundles_size_bytes_range";--> statement-breakpoint
ALTER TABLE "bundle_blobs" DROP CONSTRAINT "bundle_blobs_pkey";--> statement-breakpoint
ALTER TABLE "bundle_blobs" DROP COLUMN "agent";--> statement-breakpoint
ALTER TABLE "bundle_blobs" DROP COLUMN "scope_key";--> statement-breakpoint
ALTER TABLE "bundle_blobs" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_size_bytes_range" CHECK ("bundles"."size_bytes" between 1 and 5242880);