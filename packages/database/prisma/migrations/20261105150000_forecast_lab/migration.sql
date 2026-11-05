-- CreateTable
CREATE TABLE "forecast_lab_runs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "base_month" CHAR(7) NOT NULL,
    "window" INTEGER NOT NULL,
    "note" VARCHAR(1000),
    "results" JSONB NOT NULL,
    "forecasts" JSONB NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forecast_lab_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forecast_lab_runs_org_id_base_month_idx" ON "forecast_lab_runs"("org_id", "base_month");

-- CreateIndex
CREATE UNIQUE INDEX "forecast_lab_runs_org_id_number_key" ON "forecast_lab_runs"("org_id", "number");

-- AddForeignKey
ALTER TABLE "forecast_lab_runs" ADD CONSTRAINT "forecast_lab_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "forecast_lab_runs" ADD CONSTRAINT "forecast_lab_runs_month_check" CHECK ("base_month" ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "forecast_lab_runs" ADD CONSTRAINT "forecast_lab_runs_window_check" CHECK ("window" IN (6, 12, 18));
ALTER TABLE "forecast_lab_runs" ADD CONSTRAINT "forecast_lab_runs_json_check" CHECK (jsonb_typeof("results") = 'object' AND jsonb_typeof("forecasts") = 'array');

-- Saved forecasts are evidence of what was predicted: they are never changed or deleted.
CREATE FUNCTION t2t_forecast_lab_runs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'saved forecast runs cannot be changed or deleted' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER forecast_lab_runs_immutable BEFORE UPDATE OR DELETE ON "forecast_lab_runs" FOR EACH ROW EXECUTE FUNCTION t2t_forecast_lab_runs_immutable();

ALTER TABLE "forecast_lab_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "forecast_lab_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "forecast_lab_runs" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
