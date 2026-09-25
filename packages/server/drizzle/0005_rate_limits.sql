CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limits_window_started_at_idx" ON "rate_limits" USING btree ("window_started_at");