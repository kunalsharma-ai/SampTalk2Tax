-- CreateEnum
CREATE TYPE "GstReturnFrequency" AS ENUM ('MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "ComplianceFilingStatus" AS ENUM ('FILED', 'VOID');

-- CreateTable
CREATE TABLE "compliance_settings" (
    "org_id" UUID NOT NULL,
    "gst_return_frequency" "GstReturnFrequency" NOT NULL DEFAULT 'MONTHLY',
    "advance_tax_from" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "compliance_settings_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "compliance_filings" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "obligation_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "due_date" DATE NOT NULL,
    "filed_on" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "note" TEXT,
    "status" "ComplianceFilingStatus" NOT NULL DEFAULT 'FILED',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_by_id" UUID,
    "voided_at" TIMESTAMPTZ(6),
    "void_reason" TEXT,

    CONSTRAINT "compliance_filings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "compliance_filings_org_id_obligation_key_idx" ON "compliance_filings"("org_id", "obligation_key");

-- AddForeignKey
ALTER TABLE "compliance_settings" ADD CONSTRAINT "compliance_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_filings" ADD CONSTRAINT "compliance_filings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------------ hand-written

ALTER TABLE "compliance_filings"
  ADD CONSTRAINT "compliance_filings_text_chk" CHECK (length(btrim("reference")) BETWEEN 1 AND 100 AND "obligation_key" = "kind" || ':' || "period"),
  ADD CONSTRAINT "compliance_filings_kind_chk" CHECK ("kind" IN ('GSTR1', 'GSTR3B', 'GST_PMT06', 'GSTR9', 'TDS_STATEMENT_SALARY', 'TDS_STATEMENT', 'TCS_STATEMENT', 'ADVANCE_TAX')),
  ADD CONSTRAINT "compliance_filings_void_chk" CHECK (("status" = 'FILED' AND "voided_at" IS NULL AND "voided_by_id" IS NULL AND "void_reason" IS NULL) OR ("status" = 'VOID' AND "voided_at" IS NOT NULL AND "voided_by_id" IS NOT NULL AND length(btrim("void_reason")) > 0));
-- One standing filing per obligation.
CREATE UNIQUE INDEX "compliance_filings_live_uniq" ON "compliance_filings" ("org_id", "obligation_key") WHERE "status" = 'FILED';

CREATE OR REPLACE FUNCTION t2t_guard_compliance_filing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Filing records cannot be deleted; void them instead' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'VOID' OR NEW.status <> 'VOID'
     OR (NEW.org_id, NEW.obligation_key, NEW.kind, NEW.period, NEW.due_date, NEW.filed_on, NEW.reference, NEW.note, NEW.created_by_id, NEW.created_at)
        IS DISTINCT FROM (OLD.org_id, OLD.obligation_key, OLD.kind, OLD.period, OLD.due_date, OLD.filed_on, OLD.reference, OLD.note, OLD.created_by_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Filing records are immutable; void them instead' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compliance_filings_guard BEFORE UPDATE OR DELETE ON "compliance_filings" FOR EACH ROW EXECUTE FUNCTION t2t_guard_compliance_filing();

-- Row-level security, as for every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['compliance_settings', 'compliance_filings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
