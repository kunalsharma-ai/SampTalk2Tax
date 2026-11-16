-- CreateEnum
CREATE TYPE "KpiComparator" AS ENUM ('AT_LEAST', 'AT_MOST');

-- CreateEnum
CREATE TYPE "ManagementReportStatus" AS ENUM ('DRAFT', 'FINAL');

-- CreateTable
CREATE TABLE "kpi_targets" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kpi" VARCHAR(40) NOT NULL,
    "comparator" "KpiComparator" NOT NULL,
    "target" DECIMAL(20,4) NOT NULL,
    "note" VARCHAR(500),
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "kpi_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "management_reports" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "commentary" TEXT NOT NULL DEFAULT '',
    "status" "ManagementReportStatus" NOT NULL DEFAULT 'DRAFT',
    "snapshot" JSONB,
    "finalised_by_id" UUID,
    "finalised_at" TIMESTAMPTZ(6),
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "management_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kpi_targets_org_id_kpi_key" ON "kpi_targets"("org_id", "kpi");

-- CreateIndex
CREATE UNIQUE INDEX "management_reports_org_id_month_key" ON "management_reports"("org_id", "month");

-- AddForeignKey
ALTER TABLE "kpi_targets" ADD CONSTRAINT "kpi_targets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "management_reports" ADD CONSTRAINT "management_reports_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------- hand-written

ALTER TABLE "kpi_targets" ADD CONSTRAINT "kpi_targets_chk" CHECK (
  "kpi" IN ('revenue', 'grossMargin', 'operatingMargin', 'netMargin', 'opexRatio', 'currentRatio', 'quickRatio', 'workingCapital', 'debtToEquity', 'dso', 'dpo', 'netCashFlow', 'runway')
  AND ("note" IS NULL OR length("note") <= 500));

ALTER TABLE "management_reports" ADD CONSTRAINT "management_reports_chk" CHECK (
  extract(day FROM "month") = 1 AND length("commentary") <= 10000
  AND (("status" = 'FINAL') = ("snapshot" IS NOT NULL AND "finalised_by_id" IS NOT NULL AND "finalised_at" IS NOT NULL)));

-- A final management report is what was issued: its commentary and figures never change.
CREATE OR REPLACE FUNCTION t2t_guard_management_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN RAISE EXCEPTION 'A management report starts as a draft' USING ERRCODE = 'P0001'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'FINAL' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A final management report cannot be deleted' USING ERRCODE = 'P0001'; END IF;
    RAISE EXCEPTION 'A final management report is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.org_id <> OLD.org_id OR NEW.month <> OLD.month) THEN
    RAISE EXCEPTION 'A management report keeps its organisation and month' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER management_reports_guard BEFORE INSERT OR UPDATE OR DELETE ON "management_reports" FOR EACH ROW EXECUTE FUNCTION t2t_guard_management_report();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kpi_targets', 'management_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
