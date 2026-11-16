-- CreateEnum
CREATE TYPE "CashFlowDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "PlannedFrequency" AS ENUM ('ONCE', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateTable
CREATE TABLE "cash_flow_settings" (
    "org_id" UUID NOT NULL,
    "minimum_balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "updated_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cash_flow_settings_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "cash_flow_items" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "direction" "CashFlowDirection" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "frequency" "PlannedFrequency" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "note" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cash_flow_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_forecasts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "as_of" DATE NOT NULL,
    "horizon_days" INTEGER NOT NULL,
    "is_backtest" BOOLEAN NOT NULL,
    "opening" DECIMAL(18,2) NOT NULL,
    "closing_base" DECIMAL(18,2) NOT NULL,
    "minimum_balance" DECIMAL(18,2),
    "days" JSONB NOT NULL,
    "inputs" JSONB NOT NULL,
    "note" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_flow_items_org_id_idx" ON "cash_flow_items"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_flow_items_id_org_id_key" ON "cash_flow_items"("id", "org_id");

-- CreateIndex
CREATE INDEX "cash_forecasts_org_id_created_at_idx" ON "cash_forecasts"("org_id", "created_at");

-- AddForeignKey
ALTER TABLE "cash_flow_settings" ADD CONSTRAINT "cash_flow_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_flow_items" ADD CONSTRAINT "cash_flow_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_forecasts" ADD CONSTRAINT "cash_forecasts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- hand-written

ALTER TABLE "cash_flow_settings" ADD CONSTRAINT "cash_flow_settings_chk" CHECK ("minimum_balance" >= 0);

ALTER TABLE "cash_flow_items" ADD CONSTRAINT "cash_flow_items_chk" CHECK (
  length(btrim("name")) BETWEEN 1 AND 100 AND "amount" > 0
  AND ("end_date" IS NULL OR "end_date" >= "start_date") AND ("frequency" <> 'ONCE' OR "end_date" IS NULL)
  AND ("note" IS NULL OR length("note") <= 500));

ALTER TABLE "cash_forecasts" ADD CONSTRAINT "cash_forecasts_chk" CHECK (
  "horizon_days" BETWEEN 1 AND 400 AND jsonb_typeof("days") = 'array' AND jsonb_array_length("days") = "horizon_days"
  AND jsonb_typeof("inputs") = 'object' AND ("minimum_balance" IS NULL OR "minimum_balance" >= 0)
  AND ("is_backtest" = ("as_of" < ("created_at" AT TIME ZONE 'Asia/Kolkata')::date)));

-- Saved forecasts are evidence: never changed or deleted.
CREATE OR REPLACE FUNCTION t2t_guard_cash_forecast() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Saved cash forecasts are immutable and cannot be deleted' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER cash_forecasts_guard BEFORE UPDATE OR DELETE ON "cash_forecasts" FOR EACH ROW EXECUTE FUNCTION t2t_guard_cash_forecast();

-- Row-level security, as for every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_flow_settings', 'cash_flow_items', 'cash_forecasts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
