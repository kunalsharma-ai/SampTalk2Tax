-- Operations (M9 slice 6): feature flags, maintenance windows and error tracking. Platform
-- data for the people who run Talk2Tax; none of it is an organisation's books.

-- Feature flags. One row per flag that someone has changed; a flag without a row is at its
-- default (see packages/accounting-engine/src/feature-flags.ts).
CREATE TABLE "feature_flags" (
  "key" VARCHAR(48) NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "rollout_percent" INTEGER NOT NULL DEFAULT 100,
  "note" TEXT,
  "updated_by" UUID NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "feature_flags_rollout_check" CHECK ("rollout_percent" BETWEEN 0 AND 100)
);
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A flag forced on or off for one organisation, whatever the flag's own setting.
CREATE TABLE "feature_flag_overrides" (
  "flag_key" VARCHAR(48) NOT NULL,
  "org_id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "reason" TEXT NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feature_flag_overrides_pkey" PRIMARY KEY ("flag_key", "org_id"),
  CONSTRAINT "feature_flag_overrides_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);
CREATE INDEX "feature_flag_overrides_org_id_idx" ON "feature_flag_overrides"("org_id");
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "feature_flag_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feature_flag_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "feature_flag_overrides"
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());

-- Maintenance windows. While one is in progress, changes are paused for everyone except the
-- people who run Talk2Tax; reading and signing in keep working. At most one is open at a time.
CREATE TABLE "maintenance_windows" (
  "id" UUID NOT NULL,
  "message" TEXT NOT NULL,
  "starts_at" TIMESTAMPTZ(6) NOT NULL,
  "expected_end_at" TIMESTAMPTZ(6),
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMPTZ(6),
  "ended_by" UUID,
  CONSTRAINT "maintenance_windows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "maintenance_windows_message_check" CHECK (length(btrim("message")) BETWEEN 1 AND 500),
  CONSTRAINT "maintenance_windows_expected_check" CHECK ("expected_end_at" IS NULL OR "expected_end_at" > "starts_at"),
  CONSTRAINT "maintenance_windows_ended_check" CHECK (("ended_at" IS NULL) = ("ended_by" IS NULL))
);
CREATE UNIQUE INDEX "maintenance_windows_one_open" ON "maintenance_windows"((true)) WHERE "ended_at" IS NULL;
CREATE INDEX "maintenance_windows_starts_at_idx" ON "maintenance_windows"("starts_at");
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_ended_by_fkey" FOREIGN KEY ("ended_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Error tracking. Unexpected server errors (5xx) grouped by where they come from.
CREATE TABLE "error_groups" (
  "id" UUID NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "message" TEXT NOT NULL,
  "method" VARCHAR(8) NOT NULL,
  "route" VARCHAR(300) NOT NULL,
  "frame" VARCHAR(500),
  "occurrences" INTEGER NOT NULL DEFAULT 0,
  "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(6),
  "resolved_by" UUID,
  CONSTRAINT "error_groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "error_groups_resolved_check" CHECK (("resolved_at" IS NULL) = ("resolved_by" IS NULL))
);
CREATE UNIQUE INDEX "error_groups_fingerprint_key" ON "error_groups"("fingerprint");
CREATE INDEX "error_groups_last_seen_at_idx" ON "error_groups"("last_seen_at");
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Each occurrence. The organisation and person are kept as ids only (no foreign key), so an
-- error report never blocks removing anything; the path is kept without its query string.
CREATE TABLE "error_events" (
  "id" BIGSERIAL NOT NULL,
  "group_id" UUID NOT NULL,
  "request_id" VARCHAR(64) NOT NULL,
  "status" INTEGER NOT NULL,
  "method" VARCHAR(8) NOT NULL,
  "path" VARCHAR(500) NOT NULL,
  "org_id" UUID,
  "user_id" UUID,
  "message" TEXT NOT NULL,
  "stack" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "error_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "error_events_group_id_created_at_idx" ON "error_events"("group_id", "created_at");
CREATE INDEX "error_events_request_id_idx" ON "error_events"("request_id");
CREATE INDEX "error_events_created_at_idx" ON "error_events"("created_at");
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "error_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
