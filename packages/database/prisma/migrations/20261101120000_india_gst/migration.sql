-- M3 slice 1: India GST. Registration, GSTINs, place of supply, HSN/SAC and CGST/SGST/IGST by line.

-- CreateEnum
CREATE TYPE "TaxRateKind" AS ENUM ('SIMPLE', 'GST');

-- CreateEnum
CREATE TYPE "GstCategory" AS ENUM ('TAXABLE', 'NIL_RATED', 'EXEMPT', 'NON_GST');

-- CreateEnum
CREATE TYPE "SupplyNature" AS ENUM ('INTRA', 'INTER');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "gstin" TEXT,
ADD COLUMN     "state_code" CHAR(2);

-- AlterTable
ALTER TABLE "document_lines" ADD COLUMN     "cgst_amount" DECIMAL(24,6) NOT NULL DEFAULT 0,
ADD COLUMN     "hsn_code" TEXT,
ADD COLUMN     "igst_amount" DECIMAL(24,6) NOT NULL DEFAULT 0,
ADD COLUMN     "sgst_amount" DECIMAL(24,6) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "counterparty_gstin" TEXT,
ADD COLUMN     "place_of_supply" CHAR(2),
ADD COLUMN     "supplier_state" CHAR(2),
ADD COLUMN     "supply_nature" "SupplyNature";

-- AlterTable
ALTER TABLE "tax_rates" ADD COLUMN     "gst_category" "GstCategory",
ADD COLUMN     "kind" "TaxRateKind" NOT NULL DEFAULT 'SIMPLE';

-- CreateTable
CREATE TABLE "gst_registrations" (
    "org_id" UUID NOT NULL,
    "gstin" TEXT NOT NULL,
    "legal_name" TEXT,
    "state_code" CHAR(2) NOT NULL,
    "effective_from" DATE NOT NULL,
    "output_cgst_account_id" UUID NOT NULL,
    "output_sgst_account_id" UUID NOT NULL,
    "output_igst_account_id" UUID NOT NULL,
    "input_cgst_account_id" UUID NOT NULL,
    "input_sgst_account_id" UUID NOT NULL,
    "input_igst_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gst_registrations_pkey" PRIMARY KEY ("org_id")
);

-- AddForeignKey
ALTER TABLE "gst_registrations" ADD CONSTRAINT "gst_registrations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =====================================================================
-- Hand-written integrity rules (Directive Parts 8 and 50).
-- =====================================================================

-- GST accounts stay inside the tenant.
ALTER TABLE "gst_registrations"
  ADD CONSTRAINT "gst_reg_output_cgst_fk" FOREIGN KEY ("output_cgst_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "gst_reg_output_sgst_fk" FOREIGN KEY ("output_sgst_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "gst_reg_output_igst_fk" FOREIGN KEY ("output_igst_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "gst_reg_input_cgst_fk" FOREIGN KEY ("input_cgst_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "gst_reg_input_sgst_fk" FOREIGN KEY ("input_sgst_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "gst_reg_input_igst_fk" FOREIGN KEY ("input_igst_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  -- Shape only; the check character is verified by the API (packages/tax-engine).
  ADD CONSTRAINT "gst_reg_gstin_chk" CHECK ("gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][A-Z][0-9A-Z]$' AND "state_code" = left("gstin", 2)),
  -- Six different accounts, so output and input tax by head can each be read from the ledger.
  ADD CONSTRAINT "gst_reg_distinct_accounts_chk" CHECK (
    "output_cgst_account_id" NOT IN ("output_sgst_account_id", "output_igst_account_id", "input_cgst_account_id", "input_sgst_account_id", "input_igst_account_id")
    AND "output_sgst_account_id" NOT IN ("output_igst_account_id", "input_cgst_account_id", "input_sgst_account_id", "input_igst_account_id")
    AND "output_igst_account_id" NOT IN ("input_cgst_account_id", "input_sgst_account_id", "input_igst_account_id")
    AND "input_cgst_account_id" NOT IN ("input_sgst_account_id", "input_igst_account_id")
    AND "input_sgst_account_id" <> "input_igst_account_id");

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_gstin_chk" CHECK ("gstin" IS NULL OR ("gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][A-Z][0-9A-Z]$' AND "state_code" = left("gstin", 2))),
  ADD CONSTRAINT "contacts_state_code_chk" CHECK ("state_code" IS NULL OR "state_code" ~ '^[0-9]{2}$');

-- GST rates carry a category, have no per-rate accounts (the registration's accounts are used),
-- and only taxable rates may be above zero.
ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_kind_chk" CHECK (
    ("kind" = 'SIMPLE' AND "gst_category" IS NULL)
    OR ("kind" = 'GST' AND "gst_category" IS NOT NULL AND "sales_account_id" IS NULL AND "purchase_account_id" IS NULL
        AND ("gst_category" = 'TAXABLE' OR "rate" = 0)));

-- What a rate means never changes once created, so posted documents keep their meaning.
CREATE OR REPLACE FUNCTION t2t_guard_tax_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.rate, NEW.kind, NEW.gst_category, NEW.org_id) IS DISTINCT FROM (OLD.rate, OLD.kind, OLD.gst_category, OLD.org_id) THEN
    RAISE EXCEPTION 'A tax rate''s percentage and kind cannot change; create a new rate instead' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_rates_guard BEFORE UPDATE ON "tax_rates" FOR EACH ROW EXECUTE FUNCTION t2t_guard_tax_rate();

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_gst_chk" CHECK (
    ("place_of_supply" IS NULL AND "supplier_state" IS NULL AND "supply_nature" IS NULL AND "counterparty_gstin" IS NULL)
    OR ("place_of_supply" ~ '^[0-9]{2}$' AND "supplier_state" ~ '^[0-9]{2}$' AND "supply_nature" IS NOT NULL
        AND ("supply_nature" = 'INTRA') = ("place_of_supply" = "supplier_state" AND "place_of_supply" <> '96')));

ALTER TABLE "document_lines"
  ADD CONSTRAINT "document_lines_gst_chk" CHECK (
    "cgst_amount" >= 0 AND "sgst_amount" >= 0 AND "igst_amount" >= 0
    AND "cgst_amount" = "sgst_amount"
    AND ("igst_amount" = 0 OR "cgst_amount" = 0)
    AND ("cgst_amount" + "sgst_amount" + "igst_amount" = 0 OR "cgst_amount" + "sgst_amount" + "igst_amount" = "tax_amount")),
  ADD CONSTRAINT "document_lines_hsn_chk" CHECK ("hsn_code" IS NULL OR "hsn_code" ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$');

-- Posted documents stay immutable, now including their GST facts.
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
           NEW.place_of_supply, NEW.supplier_state, NEW.supply_nature, NEW.counterparty_gstin)
          IS DISTINCT FROM
          (OLD.kind, OLD.number, OLD.contact_id, OLD.issue_date, OLD.due_date, OLD.currency, OLD.subtotal, OLD.tax_total, OLD.total, OLD.journal_entry_id, OLD.reference,
           OLD.place_of_supply, OLD.supplier_state, OLD.supply_nature, OLD.counterparty_gstin) THEN
      RAISE EXCEPTION 'Posted document % is immutable; void it and issue a new one', OLD.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Row-level security, like every other tenant table.
ALTER TABLE gst_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gst_registrations
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
