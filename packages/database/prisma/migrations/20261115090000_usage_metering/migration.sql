-- Usage metering (M9 slice 5): one row per metered use, counted against the plan's monthly
-- limits. AI_CALL: one answered call to the AI model (tokens kept for reference). UPLOAD: one
-- attachment stored. Append-only.
CREATE TABLE "usage_events" (
  "id" BIGSERIAL NOT NULL,
  "org_id" UUID NOT NULL,
  "kind" VARCHAR(8) NOT NULL,
  "source" VARCHAR(16),
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "bytes" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "usage_events_kind_check" CHECK ("kind" IN ('AI_CALL', 'UPLOAD')),
  CONSTRAINT "usage_events_amounts_check" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "bytes" >= 0)
);
CREATE INDEX "usage_events_org_id_kind_created_at_idx" ON "usage_events"("org_id", "kind", "created_at");
CREATE INDEX "usage_events_created_at_idx" ON "usage_events"("created_at");
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER usage_events_append_only BEFORE UPDATE OR DELETE ON "usage_events" FOR EACH ROW EXECUTE FUNCTION t2t_support_append_only();

ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "usage_events"
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
