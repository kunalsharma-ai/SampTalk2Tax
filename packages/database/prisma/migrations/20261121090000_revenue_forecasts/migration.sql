-- CRM slice 5: revenue forecasts. The forecast itself is worked out live from contracts, orders,
-- the pipeline and recent sales; a saved forecast (RF-0001) keeps what was forecast on that day,
-- so later months can be compared with what was invoiced. Saved forecasts never change.

CREATE TABLE "revenue_forecasts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "as_of" DATE NOT NULL,
    "months" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "actual_so_far" DECIMAL(24,6) NOT NULL,
    "committed_total" DECIMAL(24,6) NOT NULL,
    "expected_total" DECIMAL(24,6) NOT NULL,
    "best_total" DECIMAL(24,6) NOT NULL,
    "data" JSONB NOT NULL,
    "note" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "revenue_forecasts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "revenue_forecasts_months_check" CHECK ("months" BETWEEN 1 AND 24),
    CONSTRAINT "revenue_forecasts_totals_check" CHECK ("committed_total" >= 0 AND "expected_total" >= "committed_total" AND "best_total" >= "expected_total")
);
CREATE UNIQUE INDEX "revenue_forecasts_org_id_number_key" ON "revenue_forecasts"("org_id", "number");
CREATE UNIQUE INDEX "revenue_forecasts_id_org_id_key" ON "revenue_forecasts"("id", "org_id");
CREATE INDEX "revenue_forecasts_org_id_as_of_idx" ON "revenue_forecasts"("org_id", "as_of");
ALTER TABLE "revenue_forecasts" ADD CONSTRAINT "revenue_forecasts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "revenue_forecasts" ADD CONSTRAINT "revenue_forecasts_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION t2t_guard_revenue_forecast() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A saved revenue forecast never changes' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER revenue_forecasts_guard BEFORE UPDATE OR DELETE ON "revenue_forecasts" FOR EACH ROW EXECUTE FUNCTION t2t_guard_revenue_forecast();

ALTER TABLE "revenue_forecasts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "revenue_forecasts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "revenue_forecasts" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
