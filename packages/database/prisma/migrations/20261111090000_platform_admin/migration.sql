-- Platform administration (M9 slice 1): the people who run the service, organisation
-- suspension, and announcements. None of this is tenant financial data.

-- SUPER_ADMIN runs the platform; SUPPORT can look up organisations and people but change nothing.
ALTER TABLE "users" ADD COLUMN "platform_role" VARCHAR(16);
ALTER TABLE "users" ADD CONSTRAINT "users_platform_role_check" CHECK ("platform_role" IS NULL OR "platform_role" IN ('SUPER_ADMIN', 'SUPPORT'));

-- A suspended organisation can still be read (its members keep access to their records) but not changed.
ALTER TABLE "organizations" ADD COLUMN "suspended_at" TIMESTAMPTZ(6);
ALTER TABLE "organizations" ADD COLUMN "suspended_reason" TEXT;
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_suspension_check"
  CHECK (("suspended_at" IS NULL AND "suspended_reason" IS NULL) OR ("suspended_at" IS NOT NULL AND length(btrim("suspended_reason")) > 0));

-- Messages shown to every signed-in person while they are current. Not tenant data (no org_id).
CREATE TABLE "platform_announcements" (
  "id" UUID NOT NULL,
  "message" TEXT NOT NULL,
  "tone" VARCHAR(8) NOT NULL DEFAULT 'INFO',
  "starts_at" TIMESTAMPTZ(6) NOT NULL,
  "ends_at" TIMESTAMPTZ(6),
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "withdrawn_at" TIMESTAMPTZ(6),
  "withdrawn_by" UUID,
  CONSTRAINT "platform_announcements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_announcements_tone_check" CHECK ("tone" IN ('INFO', 'WARNING')),
  CONSTRAINT "platform_announcements_message_check" CHECK (length(btrim("message")) BETWEEN 1 AND 500),
  CONSTRAINT "platform_announcements_window_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  CONSTRAINT "platform_announcements_withdrawn_check" CHECK (("withdrawn_at" IS NULL) = ("withdrawn_by" IS NULL))
);
CREATE INDEX "platform_announcements_starts_at_idx" ON "platform_announcements"("starts_at");
ALTER TABLE "platform_announcements" ADD CONSTRAINT "platform_announcements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_announcements" ADD CONSTRAINT "platform_announcements_withdrawn_by_fkey" FOREIGN KEY ("withdrawn_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
