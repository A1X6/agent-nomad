-- Custom migration: drizzle-kit cannot express column storage modes.
-- Ciphertext is encrypted, so compressing it only wastes CPU. EXTERNAL keeps large values
-- out of the table row (TOAST) without trying to compress them.
ALTER TABLE "bundle_blobs" ALTER COLUMN "ciphertext" SET STORAGE EXTERNAL;
