-- Fixed asset register, monthly depreciation runs and disposals.

-- CreateEnum
CREATE TYPE "DepreciationMethod" AS ENUM ('STRAIGHT_LINE', 'WRITTEN_DOWN_VALUE');

-- CreateEnum
CREATE TYPE "FixedAssetStatus" AS ENUM ('ACTIVE', 'DISPOSED');

-- CreateEnum
CREATE TYPE "DepreciationRunStatus" AS ENUM ('POSTED', 'REVERSED');

-- AlterEnum
ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'ASSET';

-- CreateTable
CREATE TABLE "fixed_assets" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "category" VARCHAR(100),
    "serial_number" VARCHAR(100),
    "location" VARCHAR(200),
    "asset_account_id" UUID NOT NULL,
    "accumulated_account_id" UUID NOT NULL,
    "expense_account_id" UUID NOT NULL,
    "acquisition_date" DATE NOT NULL,
    "in_service_date" DATE NOT NULL,
    "cost" DECIMAL(24,6) NOT NULL,
    "residual_value" DECIMAL(24,6) NOT NULL,
    "method" "DepreciationMethod" NOT NULL,
    "useful_life_months" INTEGER,
    "annual_rate" DECIMAL(7,4),
    "opening_accumulated" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "depreciated_through" VARCHAR(7),
    "acquisition_entry_id" UUID,
    "status" "FixedAssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "disposed_on" DATE,
    "disposal_proceeds" DECIMAL(24,6),
    "disposal_entry_id" UUID,
    "disposal_note" VARCHAR(500),
    "disposed_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depreciation_runs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "status" "DepreciationRunStatus" NOT NULL DEFAULT 'POSTED',
    "total" DECIMAL(24,6) NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "posted_by_id" UUID NOT NULL,
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversal_entry_id" UUID,
    "reversed_by_id" UUID,
    "reversed_at" TIMESTAMPTZ(6),

    CONSTRAINT "depreciation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depreciation_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,

    CONSTRAINT "depreciation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fixed_assets_org_id_status_idx" ON "fixed_assets"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_assets_org_id_number_key" ON "fixed_assets"("org_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_assets_id_org_id_key" ON "fixed_assets"("id", "org_id");

-- CreateIndex
CREATE INDEX "depreciation_runs_org_id_month_idx" ON "depreciation_runs"("org_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "depreciation_runs_id_org_id_key" ON "depreciation_runs"("id", "org_id");

-- CreateIndex
CREATE INDEX "depreciation_lines_org_id_asset_id_idx" ON "depreciation_lines"("org_id", "asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "depreciation_lines_run_id_asset_id_month_key" ON "depreciation_lines"("run_id", "asset_id", "month");

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depreciation_lines" ADD CONSTRAINT "depreciation_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depreciation_lines" ADD CONSTRAINT "depreciation_lines_run_id_org_id_fkey" FOREIGN KEY ("run_id", "org_id") REFERENCES "depreciation_runs"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depreciation_lines" ADD CONSTRAINT "depreciation_lines_asset_id_org_id_fkey" FOREIGN KEY ("asset_id", "org_id") REFERENCES "fixed_assets"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_asset_account_fk" FOREIGN KEY ("asset_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_accumulated_account_fk" FOREIGN KEY ("accumulated_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_expense_account_fk" FOREIGN KEY ("expense_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_acquisition_entry_fk" FOREIGN KEY ("acquisition_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_entry_fk" FOREIGN KEY ("disposal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_journal_fk" FOREIGN KEY ("journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_reversal_fk" FOREIGN KEY ("reversal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One posted run per month.
CREATE UNIQUE INDEX "depreciation_runs_one_posted" ON "depreciation_runs"("org_id", "month") WHERE status = 'POSTED';

ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_chk" CHECK (
  number > 0 AND length(btrim(name)) > 0
  AND cost > 0 AND residual_value >= 0 AND residual_value < cost
  AND in_service_date >= acquisition_date
  AND ((method = 'STRAIGHT_LINE' AND useful_life_months BETWEEN 1 AND 1200 AND annual_rate IS NULL)
    OR (method = 'WRITTEN_DOWN_VALUE' AND annual_rate > 0 AND annual_rate <= 100 AND useful_life_months IS NULL))
  AND opening_accumulated >= 0 AND opening_accumulated <= cost - residual_value
  AND (depreciated_through IS NULL OR depreciated_through ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
  AND (opening_accumulated = 0 OR depreciated_through IS NOT NULL)
  AND ((status = 'ACTIVE' AND disposed_on IS NULL AND disposal_proceeds IS NULL AND disposal_entry_id IS NULL AND disposed_by_id IS NULL)
    OR (status = 'DISPOSED' AND disposed_on IS NOT NULL AND disposed_on >= in_service_date AND disposal_proceeds >= 0 AND disposal_entry_id IS NOT NULL AND disposed_by_id IS NOT NULL))
);
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_chk" CHECK (
  month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND total > 0
  AND ((status = 'POSTED' AND reversal_entry_id IS NULL AND reversed_by_id IS NULL AND reversed_at IS NULL)
    OR (status = 'REVERSED' AND reversal_entry_id IS NOT NULL AND reversed_by_id IS NOT NULL AND reversed_at IS NOT NULL))
);
ALTER TABLE "depreciation_lines" ADD CONSTRAINT "depreciation_lines_chk" CHECK (amount > 0 AND month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- Assets are never deleted; their terms are fixed once depreciation has been posted for them, and a disposal is final.
CREATE FUNCTION t2t_guard_fixed_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Fixed assets are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.number <> OLD.number OR NEW.created_by_id <> OLD.created_by_id OR NEW.acquisition_entry_id IS DISTINCT FROM OLD.acquisition_entry_id THEN
    RAISE EXCEPTION 'A fixed asset keeps its organisation, number and purchase entry' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'DISPOSED' THEN
    RAISE EXCEPTION 'A disposed asset cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM depreciation_lines l WHERE l.asset_id = OLD.id) AND (
    NEW.cost <> OLD.cost OR NEW.residual_value <> OLD.residual_value OR NEW.method <> OLD.method
    OR NEW.useful_life_months IS DISTINCT FROM OLD.useful_life_months OR NEW.annual_rate IS DISTINCT FROM OLD.annual_rate
    OR NEW.opening_accumulated <> OLD.opening_accumulated OR NEW.depreciated_through IS DISTINCT FROM OLD.depreciated_through
    OR NEW.in_service_date <> OLD.in_service_date OR NEW.acquisition_date <> OLD.acquisition_date
    OR NEW.asset_account_id <> OLD.asset_account_id OR NEW.accumulated_account_id <> OLD.accumulated_account_id OR NEW.expense_account_id <> OLD.expense_account_id
  ) THEN
    RAISE EXCEPTION 'Depreciation has been posted for this asset, so its cost, dates, accounts and depreciation terms are fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixed_assets_guard BEFORE UPDATE OR DELETE ON "fixed_assets" FOR EACH ROW EXECUTE FUNCTION t2t_guard_fixed_asset();

-- Runs are never deleted; a posted run changes only to record its reversal.
CREATE FUNCTION t2t_guard_depreciation_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Depreciation runs are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'REVERSED' OR NEW.status <> 'REVERSED' OR NEW.org_id <> OLD.org_id OR NEW.month <> OLD.month OR NEW.total <> OLD.total
     OR NEW.journal_entry_id <> OLD.journal_entry_id OR NEW.posted_by_id <> OLD.posted_by_id OR NEW.posted_at <> OLD.posted_at THEN
    RAISE EXCEPTION 'A depreciation run changes only to record its reversal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER depreciation_runs_guard BEFORE UPDATE OR DELETE ON "depreciation_runs" FOR EACH ROW EXECUTE FUNCTION t2t_guard_depreciation_run();

CREATE FUNCTION t2t_guard_depreciation_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Depreciation lines are never changed or deleted' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER depreciation_lines_guard BEFORE UPDATE OR DELETE ON "depreciation_lines" FOR EACH ROW EXECUTE FUNCTION t2t_guard_depreciation_line();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fixed_assets', 'depreciation_runs', 'depreciation_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
