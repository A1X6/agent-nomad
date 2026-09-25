CREATE TABLE "bundle_blobs" (
	"user_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"scope_key" text NOT NULL,
	"revision" integer NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bundle_blobs_pkey" PRIMARY KEY("user_id","agent","scope_key","revision"),
	CONSTRAINT "bundle_blobs_revision_positive" CHECK ("bundle_blobs"."revision" >= 1),
	CONSTRAINT "bundle_blobs_ciphertext_size" CHECK (octet_length("bundle_blobs"."ciphertext") <= 5242880)
);
--> statement-breakpoint
CREATE TABLE "bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"scope_key" text NOT NULL,
	"name_enc" "bytea",
	"content_hash" "bytea" NOT NULL,
	"format_ver" integer NOT NULL,
	"revision" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bundles_revision_positive" CHECK ("bundles"."revision" >= 1),
	CONSTRAINT "bundles_format_ver_positive" CHECK ("bundles"."format_ver" >= 1),
	CONSTRAINT "bundles_size_bytes_range" CHECK ("bundles"."size_bytes" between 0 and 5242880),
	CONSTRAINT "bundles_content_hash_length" CHECK (octet_length("bundles"."content_hash") = 32),
	CONSTRAINT "bundles_name_enc_length" CHECK ("bundles"."name_enc" is null or octet_length("bundles"."name_enc") <= 512)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"kdf_salt" "bytea" NOT NULL,
	"kdf_params" jsonb NOT NULL,
	"auth_hash" text NOT NULL,
	"wrapped_data_key" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_kdf_salt_length" CHECK (octet_length("users"."kdf_salt") = 16),
	CONSTRAINT "users_wrapped_data_key_length" CHECK (octet_length("users"."wrapped_data_key") = 72)
);
--> statement-breakpoint
ALTER TABLE "bundle_blobs" ADD CONSTRAINT "bundle_blobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bundles_user_agent_scope_key" ON "bundles" USING btree ("user_id","agent","scope_key");--> statement-breakpoint
CREATE INDEX "bundles_user_updated_idx" ON "bundles" USING btree ("user_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_key" ON "users" USING btree ("username");