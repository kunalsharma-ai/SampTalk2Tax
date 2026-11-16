-- CRM slice 3: customer contracts billed every period into draft invoices.
CREATE TYPE "SalesContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED', 'CANCELLED');
CREATE TYPE "ContractFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY');
CREATE TYPE "ContractTiming" AS ENUM ('ADVANCE', 'ARREARS');
CREATE TYPE "ContractPeriodStatus" AS ENUM ('BILLED', 'SKIPPED');

CREATE TABLE "sales_contracts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "contact_id" UUID NOT NULL,
    "deal_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "status" "SalesContractStatus" NOT NULL DEFAULT 'DRAFT',
    "frequency" "ContractFrequency" NOT NULL,
    "timing" "ContractTiming" NOT NULL DEFAULT 'ADVANCE',
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "next_period_no" INTEGER NOT NULL DEFAULT 1,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "renewal_months" INTEGER,
    "notice_days" INTEGER NOT NULL DEFAULT 30,
    "payment_terms_days" INTEGER,
    "place_of_supply" CHAR(2),
    "reference" VARCHAR(100),
    "memo" VARCHAR(1000),
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(24,6) NOT NULL,
    "tax_total" DECIMAL(24,6) NOT NULL,
    "total" DECIMAL(24,6) NOT NULL,
    "activated_at" TIMESTAMPTZ(6),
    "cancel_reason" VARCHAR(500),
    "cancelled_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "last_error" VARCHAR(1000),
    "last_error_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "sales_contracts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_contract_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" VARCHAR(500),
    "account_id" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "unit_price" DECIMAL(24,6) NOT NULL,
    "tax_rate_id" UUID,
    "hsn_code" TEXT,
    "net_amount" DECIMAL(24,6) NOT NULL,
    "tax_amount" DECIMAL(24,6) NOT NULL,
    CONSTRAINT "sales_contract_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_contract_periods" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "period_no" INTEGER NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "ContractPeriodStatus" NOT NULL,
    "document_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "sales_contract_periods_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_contract_events" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "data" JSONB,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_contract_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_contracts_org_id_number_key" ON "sales_contracts"("org_id", "number");
CREATE UNIQUE INDEX "sales_contracts_id_org_id_key" ON "sales_contracts"("id", "org_id");
CREATE INDEX "sales_contracts_org_id_status_idx" ON "sales_contracts"("org_id", "status");
CREATE INDEX "sales_contracts_org_id_contact_id_idx" ON "sales_contracts"("org_id", "contact_id");
CREATE INDEX "sales_contracts_status_idx" ON "sales_contracts"("status");
CREATE UNIQUE INDEX "sales_contract_lines_contract_id_line_no_key" ON "sales_contract_lines"("contract_id", "line_no");
CREATE UNIQUE INDEX "sales_contract_lines_id_org_id_key" ON "sales_contract_lines"("id", "org_id");
CREATE UNIQUE INDEX "sales_contract_periods_contract_id_period_no_key" ON "sales_contract_periods"("contract_id", "period_no");
CREATE INDEX "sales_contract_periods_org_id_document_id_idx" ON "sales_contract_periods"("org_id", "document_id");
CREATE INDEX "sales_contract_events_contract_id_created_at_idx" ON "sales_contract_events"("contract_id", "created_at");

ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_deal_fk" FOREIGN KEY ("deal_id", "org_id") REFERENCES "crm_deals"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_contract_lines" ADD CONSTRAINT "sales_contract_lines_contract_id_fkey" FOREIGN KEY ("contract_id", "org_id") REFERENCES "sales_contracts"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_contract_lines" ADD CONSTRAINT "sales_contract_lines_account_fk" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_contract_lines" ADD CONSTRAINT "sales_contract_lines_tax_fk" FOREIGN KEY ("tax_rate_id", "org_id") REFERENCES "tax_rates"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_contract_periods" ADD CONSTRAINT "sales_contract_periods_contract_id_fkey" FOREIGN KEY ("contract_id", "org_id") REFERENCES "sales_contracts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Deleting a draft invoice leaves the period billed with no invoice, so it can be billed again.
ALTER TABLE "sales_contract_periods" ADD CONSTRAINT "sales_contract_periods_document_fk" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales_contract_events" ADD CONSTRAINT "sales_contract_events_contract_id_fkey" FOREIGN KEY ("contract_id", "org_id") REFERENCES "sales_contracts"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_contract_events" ADD CONSTRAINT "sales_contract_events_actor_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_chk" CHECK (
  number > 0 AND next_period_no > 0 AND (end_date IS NULL OR end_date >= start_date)
  AND subtotal >= 0 AND tax_total >= 0 AND total = subtotal + tax_total
  AND notice_days BETWEEN 0 AND 365 AND (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365)
  AND (NOT auto_renew OR (end_date IS NOT NULL AND renewal_months IS NOT NULL))
  AND (renewal_months IS NULL OR renewal_months BETWEEN 1 AND 120)
  AND ((status = 'CANCELLED') = (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL))
  AND (status = 'DRAFT' OR activated_at IS NOT NULL)
  AND (status <> 'DRAFT' OR next_period_no = 1)
);
ALTER TABLE "sales_contract_lines" ADD CONSTRAINT "sales_contract_lines_chk" CHECK (line_no > 0 AND quantity > 0 AND unit_price >= 0 AND net_amount >= 0 AND tax_amount >= 0);
ALTER TABLE "sales_contract_periods" ADD CONSTRAINT "sales_contract_periods_chk" CHECK (period_no > 0 AND period_end >= period_start AND (status = 'BILLED' OR document_id IS NULL));

-- Contracts: only drafts are deleted; the customer, number and schedule stay once active; a
-- cancelled contract never changes again.
CREATE FUNCTION t2t_guard_sales_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only a draft contract can be deleted' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.number <> OLD.number OR NEW.created_by_id <> OLD.created_by_id THEN
    RAISE EXCEPTION 'A contract keeps its number and creator' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'A cancelled contract does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.contact_id <> OLD.contact_id OR NEW.start_date <> OLD.start_date OR NEW.frequency <> OLD.frequency OR NEW.timing <> OLD.timing OR NEW.status = 'DRAFT') THEN
    RAISE EXCEPTION 'An active contract keeps its customer and billing schedule' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.next_period_no < OLD.next_period_no THEN
    RAISE EXCEPTION 'Billed periods are not undone' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_contracts_guard BEFORE UPDATE OR DELETE ON "sales_contracts" FOR EACH ROW EXECUTE FUNCTION t2t_guard_sales_contract();

CREATE FUNCTION t2t_guard_sales_contract_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "SalesContractStatus";
BEGIN
  SELECT status INTO s FROM sales_contracts WHERE id = COALESCE(NEW.contract_id, OLD.contract_id);
  -- s is NULL while a draft contract is being deleted with its lines.
  IF s IN ('ENDED', 'CANCELLED') THEN
    RAISE EXCEPTION 'An ended or cancelled contract''s lines do not change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER sales_contract_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "sales_contract_lines" FOR EACH ROW EXECUTE FUNCTION t2t_guard_sales_contract_line();

-- A period is never removed or moved; its invoice is replaced only when the old one was deleted
-- (set to NULL) or voided.
CREATE FUNCTION t2t_guard_sales_contract_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Contract periods are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.contract_id <> OLD.contract_id OR NEW.org_id <> OLD.org_id OR NEW.period_no <> OLD.period_no OR NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end OR NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'A contract period does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id AND NEW.document_id IS NOT NULL AND OLD.document_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM documents WHERE id = OLD.document_id AND status = 'VOID') THEN
    RAISE EXCEPTION 'A period is billed again only after its invoice is voided or deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_contract_periods_guard BEFORE UPDATE OR DELETE ON "sales_contract_periods" FOR EACH ROW EXECUTE FUNCTION t2t_guard_sales_contract_period();

CREATE FUNCTION t2t_guard_sales_contract_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM sales_contracts WHERE id = OLD.contract_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'The contract history is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER sales_contract_events_guard BEFORE UPDATE OR DELETE ON "sales_contract_events" FOR EACH ROW EXECUTE FUNCTION t2t_guard_sales_contract_event();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_contracts', 'sales_contract_lines', 'sales_contract_periods', 'sales_contract_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
