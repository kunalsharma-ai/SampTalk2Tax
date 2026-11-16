-- CreateEnum
CREATE TYPE "WithholdingKind" AS ENUM ('TDS', 'TCS');

-- CreateEnum
CREATE TYPE "ThresholdWindow" AS ENUM ('TAX_YEAR', 'MONTH');

-- CreateEnum
CREATE TYPE "ThresholdBasis" AS ENUM ('WHOLE', 'EXCESS');

-- AlterEnum (TAX: tax payments to the government, such as TDS/TCS challans)
ALTER TYPE "JournalSource" ADD VALUE 'TAX';

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "pan" CHAR(10),
ADD COLUMN     "withholding_section_id" UUID;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "counterparty_pan" CHAR(10),
ADD COLUMN     "reverse_charge" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reverse_charge_tax" DECIMAL(24,6) NOT NULL DEFAULT 0,
ADD COLUMN     "withholding_amount" DECIMAL(24,6) NOT NULL DEFAULT 0,
ADD COLUMN     "withholding_base" DECIMAL(24,6) NOT NULL DEFAULT 0,
ADD COLUMN     "withholding_kind" "WithholdingKind",
ADD COLUMN     "withholding_rate" DECIMAL(9,6) NOT NULL DEFAULT 0,
ADD COLUMN     "withholding_section_id" UUID,
ADD COLUMN     "withholding_subject" DECIMAL(24,6) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "withholding_settings" (
    "org_id" UUID NOT NULL,
    "tan" CHAR(10) NOT NULL,
    "tds_payable_account_id" UUID NOT NULL,
    "tcs_payable_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "withholding_settings_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "withholding_sections" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" "WithholdingKind" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(9,6) NOT NULL,
    "rate_individual_huf" DECIMAL(9,6),
    "rate_no_pan" DECIMAL(9,6) NOT NULL,
    "single_threshold" DECIMAL(24,6),
    "aggregate_threshold" DECIMAL(24,6),
    "threshold_window" "ThresholdWindow" NOT NULL,
    "threshold_basis" "ThresholdBasis" NOT NULL,
    "valid_from" DATE NOT NULL,
    "source" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withholding_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withholding_deposits" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" "WithholdingKind" NOT NULL,
    "number" TEXT NOT NULL,
    "deposit_date" DATE NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "challan_reference" TEXT NOT NULL,
    "tax_amount" DECIMAL(24,6) NOT NULL,
    "interest_amount" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "interest_account_id" UUID,
    "memo" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'POSTED',
    "journal_entry_id" UUID NOT NULL,
    "void_journal_entry_id" UUID,
    "void_date" DATE,
    "void_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withholding_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withholding_deposit_items" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "deposit_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "withholding_deposit_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "withholding_sections_org_id_kind_code_key" ON "withholding_sections"("org_id", "kind", "code");

-- CreateIndex
CREATE UNIQUE INDEX "withholding_sections_id_org_id_key" ON "withholding_sections"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "withholding_deposits_journal_entry_id_key" ON "withholding_deposits"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "withholding_deposits_void_journal_entry_id_key" ON "withholding_deposits"("void_journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "withholding_deposits_org_id_kind_number_key" ON "withholding_deposits"("org_id", "kind", "number");

-- CreateIndex
CREATE UNIQUE INDEX "withholding_deposits_id_org_id_key" ON "withholding_deposits"("id", "org_id");

-- CreateIndex
CREATE INDEX "withholding_deposit_items_org_id_document_id_idx" ON "withholding_deposit_items"("org_id", "document_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_withholding_section_fk" FOREIGN KEY ("withholding_section_id", "org_id") REFERENCES "withholding_sections"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withholding_settings" ADD CONSTRAINT "withholding_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withholding_sections" ADD CONSTRAINT "withholding_sections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withholding_deposits" ADD CONSTRAINT "withholding_deposits_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withholding_deposit_items" ADD CONSTRAINT "withholding_deposit_items_deposit_id_org_id_fkey" FOREIGN KEY ("deposit_id", "org_id") REFERENCES "withholding_deposits"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withholding_deposit_items" ADD CONSTRAINT "withholding_deposit_items_document_id_org_id_fkey" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------- hand-written

-- Accounts and journals stay inside the tenant.
ALTER TABLE "withholding_settings"
  ADD CONSTRAINT "withholding_settings_tds_account_fk" FOREIGN KEY ("tds_payable_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "withholding_settings_tcs_account_fk" FOREIGN KEY ("tcs_payable_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "withholding_settings_tan_chk" CHECK ("tan" ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  ADD CONSTRAINT "withholding_settings_accounts_chk" CHECK ("tds_payable_account_id" <> "tcs_payable_account_id");

ALTER TABLE "withholding_sections"
  ADD CONSTRAINT "withholding_sections_rates_chk" CHECK (
    "rate" > 0 AND "rate" <= 100 AND "rate_no_pan" >= 0 AND "rate_no_pan" <= 100
    AND ("rate_individual_huf" IS NULL OR ("rate_individual_huf" > 0 AND "rate_individual_huf" <= 100))
    AND ("single_threshold" IS NULL OR "single_threshold" > 0)
    AND ("aggregate_threshold" IS NULL OR "aggregate_threshold" > 0)
    AND ("threshold_basis" = 'WHOLE' OR ("aggregate_threshold" IS NOT NULL AND "single_threshold" IS NULL)));

-- A section's rule cannot change once created, so every document keeps its meaning; create a new section instead.
CREATE OR REPLACE FUNCTION t2t_guard_withholding_section() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Withholding sections cannot be deleted; deactivate them' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.org_id, NEW.kind, NEW.code, NEW.rate, NEW.rate_individual_huf, NEW.rate_no_pan, NEW.single_threshold, NEW.aggregate_threshold, NEW.threshold_window, NEW.threshold_basis, NEW.valid_from)
     IS DISTINCT FROM
     (OLD.org_id, OLD.kind, OLD.code, OLD.rate, OLD.rate_individual_huf, OLD.rate_no_pan, OLD.single_threshold, OLD.aggregate_threshold, OLD.threshold_window, OLD.threshold_basis, OLD.valid_from) THEN
    RAISE EXCEPTION 'A withholding section''s rates and thresholds cannot change; create a new section instead' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER withholding_sections_guard BEFORE UPDATE OR DELETE ON "withholding_sections" FOR EACH ROW EXECUTE FUNCTION t2t_guard_withholding_section();

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_withholding_section_fk" FOREIGN KEY ("withholding_section_id", "org_id") REFERENCES "withholding_sections"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "contacts_pan_chk" CHECK ("pan" IS NULL OR ("pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' AND ("gstin" IS NULL OR substr("gstin", 3, 10) = "pan")));

-- What a document settles with its contact: TDS lowers a bill's total, TCS raises an invoice's.
ALTER TABLE "documents" DROP CONSTRAINT "documents_amounts_chk";
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_amounts_chk" CHECK (
    "total" = "subtotal" + "tax_total"
      + CASE "withholding_kind" WHEN 'TCS' THEN "withholding_amount" WHEN 'TDS' THEN -"withholding_amount" ELSE 0 END
    AND "total" > 0 AND "subtotal" >= 0 AND "tax_total" >= 0),
  ADD CONSTRAINT "documents_withholding_chk" CHECK (
    ("withholding_section_id" IS NULL AND "withholding_kind" IS NULL AND "withholding_subject" = 0 AND "withholding_base" = 0 AND "withholding_rate" = 0 AND "withholding_amount" = 0)
    OR ("withholding_section_id" IS NOT NULL
        AND (("withholding_kind" = 'TDS' AND "kind" = 'BILL') OR ("withholding_kind" = 'TCS' AND "kind" = 'INVOICE'))
        AND "withholding_subject" >= 0 AND "withholding_base" >= 0 AND "withholding_rate" > 0 AND "withholding_rate" <= 100 AND "withholding_amount" >= 0)),
  ADD CONSTRAINT "documents_counterparty_pan_chk" CHECK ("counterparty_pan" IS NULL OR "counterparty_pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  -- Reverse charge is a GST purchase: the tax is on the lines but not charged by the supplier.
  ADD CONSTRAINT "documents_reverse_charge_chk" CHECK (
    ("reverse_charge" = false AND "reverse_charge_tax" = 0)
    OR ("reverse_charge" = true AND "kind" IN ('BILL', 'VENDOR_CREDIT') AND "place_of_supply" IS NOT NULL AND "tax_total" = 0 AND "reverse_charge_tax" >= 0));

-- Posted documents stay as they were posted, including their GST, reverse-charge and withholding facts.
CREATE OR REPLACE FUNCTION t2t_guard_document() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Posted document % cannot be deleted; void it instead', OLD.id USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'Void document % is immutable', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'POSTED' THEN
    IF NEW.status <> 'VOID'
       OR (NEW.kind, NEW.number, NEW.contact_id, NEW.issue_date, NEW.due_date, NEW.currency, NEW.subtotal, NEW.tax_total, NEW.total, NEW.journal_entry_id, NEW.reference,
           NEW.place_of_supply, NEW.supplier_state, NEW.supply_nature, NEW.counterparty_gstin,
           NEW.reverse_charge, NEW.reverse_charge_tax, NEW.withholding_section_id, NEW.withholding_kind, NEW.withholding_subject, NEW.withholding_base,
           NEW.withholding_rate, NEW.withholding_amount, NEW.counterparty_pan)
          IS DISTINCT FROM
          (OLD.kind, OLD.number, OLD.contact_id, OLD.issue_date, OLD.due_date, OLD.currency, OLD.subtotal, OLD.tax_total, OLD.total, OLD.journal_entry_id, OLD.reference,
           OLD.place_of_supply, OLD.supplier_state, OLD.supply_nature, OLD.counterparty_gstin,
           OLD.reverse_charge, OLD.reverse_charge_tax, OLD.withholding_section_id, OLD.withholding_kind, OLD.withholding_subject, OLD.withholding_base,
           OLD.withholding_rate, OLD.withholding_amount, OLD.counterparty_pan) THEN
      RAISE EXCEPTION 'Posted document % is immutable; void it and issue a new one', OLD.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A document whose withheld tax is in a deposit cannot be voided; void the deposit first.
CREATE OR REPLACE FUNCTION t2t_check_void_deposited() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'POSTED' AND NEW.status = 'VOID'
     AND EXISTS (SELECT 1 FROM withholding_deposit_items i WHERE i.document_id = NEW.id AND i.active) THEN
    RAISE EXCEPTION 'Document % has withheld tax in a deposit; void the deposit first', NEW.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_void_deposited_check BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION t2t_check_void_deposited();

ALTER TABLE "withholding_deposits"
  ADD CONSTRAINT "withholding_deposits_journal_fk" FOREIGN KEY ("journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "withholding_deposits_void_journal_fk" FOREIGN KEY ("void_journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "withholding_deposits_bank_fk" FOREIGN KEY ("bank_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "withholding_deposits_interest_account_fk" FOREIGN KEY ("interest_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "withholding_deposits_amounts_chk" CHECK ("tax_amount" > 0 AND "interest_amount" >= 0 AND ("interest_amount" = 0 OR "interest_account_id" IS NOT NULL)),
  ADD CONSTRAINT "withholding_deposits_void_chk" CHECK (("status" = 'POSTED') = ("void_journal_entry_id" IS NULL) AND ("status" = 'POSTED') = ("void_date" IS NULL));

CREATE OR REPLACE FUNCTION t2t_guard_withholding_deposit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deposit % cannot be deleted; void it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'VOID' OR NEW.status <> 'VOID'
     OR (NEW.org_id, NEW.kind, NEW.number, NEW.deposit_date, NEW.bank_account_id, NEW.challan_reference, NEW.tax_amount, NEW.interest_amount, NEW.interest_account_id, NEW.journal_entry_id)
        IS DISTINCT FROM
        (OLD.org_id, OLD.kind, OLD.number, OLD.deposit_date, OLD.bank_account_id, OLD.challan_reference, OLD.tax_amount, OLD.interest_amount, OLD.interest_account_id, OLD.journal_entry_id) THEN
    RAISE EXCEPTION 'Deposit % is immutable; void it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER withholding_deposits_guard BEFORE UPDATE OR DELETE ON "withholding_deposits" FOR EACH ROW EXECUTE FUNCTION t2t_guard_withholding_deposit();

ALTER TABLE "withholding_deposit_items" ADD CONSTRAINT "withholding_deposit_items_amount_chk" CHECK ("amount" > 0);
-- A document's withheld tax is in at most one live deposit.
CREATE UNIQUE INDEX "withholding_deposit_items_active_uniq" ON "withholding_deposit_items" ("document_id") WHERE "active";

CREATE OR REPLACE FUNCTION t2t_guard_withholding_deposit_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deposit items cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NOT OLD.active OR NEW.active
     OR (NEW.org_id, NEW.deposit_id, NEW.document_id, NEW.amount) IS DISTINCT FROM (OLD.org_id, OLD.deposit_id, OLD.document_id, OLD.amount)
     OR NOT EXISTS (SELECT 1 FROM withholding_deposits d WHERE d.id = OLD.deposit_id AND d.status = 'VOID') THEN
    RAISE EXCEPTION 'Deposit items only change when their deposit is voided' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER withholding_deposit_items_guard BEFORE UPDATE OR DELETE ON "withholding_deposit_items" FOR EACH ROW EXECUTE FUNCTION t2t_guard_withholding_deposit_item();

-- Row-level security, as for every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['withholding_settings', 'withholding_sections', 'withholding_deposits', 'withholding_deposit_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
