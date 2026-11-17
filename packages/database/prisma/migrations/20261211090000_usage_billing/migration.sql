-- AR-012 usage-based billing: meters on customer contracts and the usage recorded against them,
-- billed in arrears on each period's invoice.

CREATE TYPE "UsagePricing" AS ENUM ('PER_UNIT', 'GRADUATED', 'VOLUME');

CREATE TABLE "contract_meters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "unit" VARCHAR(30) NOT NULL,
    "account_id" UUID NOT NULL,
    "tax_rate_id" UUID,
    "hsn_code" TEXT,
    "pricing" "UsagePricing" NOT NULL,
    "tiers" JSONB NOT NULL,
    "included_quantity" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "minimum_charge" DECIMAL(24,6),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "contract_meters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "contract_meters_contract_id_code_key" ON "contract_meters"("contract_id", "code");
CREATE UNIQUE INDEX "contract_meters_id_org_id_key" ON "contract_meters"("id", "org_id");
CREATE INDEX "contract_meters_org_id_idx" ON "contract_meters"("org_id");
ALTER TABLE "contract_meters" ADD CONSTRAINT "contract_meters_contract_fk" FOREIGN KEY ("contract_id", "org_id") REFERENCES "sales_contracts"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contract_meters" ADD CONSTRAINT "contract_meters_account_fk" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contract_meters" ADD CONSTRAINT "contract_meters_tax_fk" FOREIGN KEY ("tax_rate_id", "org_id") REFERENCES "tax_rates"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contract_meters" ADD CONSTRAINT "contract_meters_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contract_meters" ADD CONSTRAINT "contract_meters_chk" CHECK (
  code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$' AND length(trim(name)) > 0 AND length(trim(unit)) > 0
  AND included_quantity >= 0 AND (minimum_charge IS NULL OR minimum_charge >= 0)
  AND jsonb_typeof(tiers) = 'array' AND jsonb_array_length(tiers) BETWEEN 1 AND 20
  AND (pricing <> 'PER_UNIT' OR jsonb_array_length(tiers) = 1)
);

CREATE TABLE "usage_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "usage_date" DATE NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "reference" VARCHAR(100),
    "note" VARCHAR(500),
    "source" VARCHAR(10) NOT NULL,
    "period_no" INTEGER,
    "document_id" UUID,
    "voided_at" TIMESTAMPTZ(6),
    "voided_by_id" UUID,
    "void_reason" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "usage_records_meter_date_idx" ON "usage_records"("meter_id", "usage_date");
CREATE INDEX "usage_records_contract_period_idx" ON "usage_records"("contract_id", "period_no");
CREATE INDEX "usage_records_org_id_idx" ON "usage_records"("org_id");
-- A reading sent twice with the same reference is recorded once.
CREATE UNIQUE INDEX "usage_records_meter_reference_key" ON "usage_records"("meter_id", "reference") WHERE "reference" IS NOT NULL AND "voided_at" IS NULL;
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_contract_fk" FOREIGN KEY ("contract_id", "org_id") REFERENCES "sales_contracts"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_meter_fk" FOREIGN KEY ("meter_id", "org_id") REFERENCES "contract_meters"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_document_fk" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_voided_by_fk" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_chk" CHECK (
  source IN ('MANUAL', 'IMPORT', 'API')
  AND (period_no IS NULL OR period_no > 0)
  AND (document_id IS NULL OR period_no IS NOT NULL)
  AND ((voided_at IS NULL) = (voided_by_id IS NULL AND void_reason IS NULL))
  AND (voided_at IS NULL OR period_no IS NULL)
);

-- A meter belongs to one contract and keeps its code; meters of an ended or cancelled contract
-- do not change; a meter with usage is never deleted (the foreign key) but can be switched off.
CREATE FUNCTION t2t_guard_contract_meter() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "SalesContractStatus";
BEGIN
  SELECT status INTO s FROM sales_contracts WHERE id = COALESCE(NEW.contract_id, OLD.contract_id);
  IF s IN ('ENDED', 'CANCELLED') THEN
    RAISE EXCEPTION 'An ended or cancelled contract''s meters do not change' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.contract_id <> OLD.contract_id OR NEW.org_id <> OLD.org_id OR NEW.code <> OLD.code) THEN
    RAISE EXCEPTION 'A meter keeps its contract and code' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER contract_meters_guard BEFORE INSERT OR UPDATE OR DELETE ON "contract_meters" FOR EACH ROW EXECUTE FUNCTION t2t_guard_contract_meter();

-- Usage is never deleted or edited: a mistake is voided (before it is billed) and recorded
-- again. Billing sets the period once; the invoice changes only when the period is billed again.
CREATE FUNCTION t2t_guard_usage_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM sales_contracts WHERE id = OLD.contract_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Usage is never deleted; void it instead' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.contract_id <> OLD.contract_id OR NEW.meter_id <> OLD.meter_id OR NEW.usage_date <> OLD.usage_date
     OR NEW.quantity <> OLD.quantity OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.source <> OLD.source OR NEW.created_by_id <> OLD.created_by_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Recorded usage does not change; void it and record it again' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Voided usage does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.period_no IS NOT NULL AND NEW.period_no IS DISTINCT FROM OLD.period_no THEN
    RAISE EXCEPTION 'Billed usage stays with its period' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.voided_at IS NOT NULL AND OLD.period_no IS NOT NULL THEN
    RAISE EXCEPTION 'Billed usage cannot be voided' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER usage_records_guard BEFORE UPDATE OR DELETE ON "usage_records" FOR EACH ROW EXECUTE FUNCTION t2t_guard_usage_record();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract_meters', 'usage_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
