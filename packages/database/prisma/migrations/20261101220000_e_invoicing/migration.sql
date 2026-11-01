-- CreateEnum
CREATE TYPE "EInvoiceStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "city" TEXT,
ADD COLUMN     "pincode" CHAR(6);

-- CreateTable
CREATE TABLE "e_invoice_settings" (
    "org_id" UUID NOT NULL,
    "applicable_from" DATE NOT NULL,
    "aato_ten_crore_or_more" BOOLEAN NOT NULL DEFAULT false,
    "trade_name" TEXT,
    "address1" TEXT NOT NULL,
    "address2" TEXT,
    "city" TEXT NOT NULL,
    "pincode" CHAR(6) NOT NULL,
    "goods_unit" TEXT NOT NULL DEFAULT 'NOS',
    "irp_public_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "e_invoice_settings_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "e_invoices" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "irn" CHAR(64) NOT NULL,
    "ack_no" TEXT NOT NULL,
    "ack_date" TIMESTAMPTZ(6) NOT NULL,
    "signed_qr_code" TEXT NOT NULL,
    "signed_invoice" TEXT,
    "signature_verified" BOOLEAN NOT NULL DEFAULT false,
    "payload_hash" CHAR(64) NOT NULL,
    "status" "EInvoiceStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" CHAR(1),
    "cancel_remark" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_by_id" UUID,

    CONSTRAINT "e_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "e_invoices_document_id_idx" ON "e_invoices"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "e_invoices_org_id_irn_key" ON "e_invoices"("org_id", "irn");

-- AddForeignKey
ALTER TABLE "e_invoice_settings" ADD CONSTRAINT "e_invoice_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_invoices" ADD CONSTRAINT "e_invoices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_invoices" ADD CONSTRAINT "e_invoices_document_id_org_id_fkey" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------------ hand-written

ALTER TABLE "contacts" ADD CONSTRAINT "contacts_pincode_chk" CHECK ("pincode" IS NULL OR "pincode" ~ '^[1-9][0-9]{5}$');

ALTER TABLE "e_invoice_settings"
  ADD CONSTRAINT "e_invoice_settings_chk" CHECK ("pincode" ~ '^[1-9][0-9]{5}$' AND length(btrim("address1")) BETWEEN 1 AND 100 AND length(btrim("city")) BETWEEN 3 AND 50 AND "goods_unit" ~ '^[A-Z]{3,8}$');

ALTER TABLE "e_invoices"
  ADD CONSTRAINT "e_invoices_chk" CHECK ("irn" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "ack_no" ~ '^[0-9]{10,20}$'),
  ADD CONSTRAINT "e_invoices_cancel_chk" CHECK (
    ("status" = 'ACTIVE' AND "cancelled_at" IS NULL AND "cancel_reason" IS NULL AND "cancelled_by_id" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancel_reason" IN ('1', '2', '3', '4') AND "cancelled_by_id" IS NOT NULL
        AND "cancelled_at" >= "ack_date" AND "cancelled_at" <= "ack_date" + interval '24 hours'));
-- One live IRN per document.
CREATE UNIQUE INDEX "e_invoices_document_live_uniq" ON "e_invoices" ("document_id") WHERE "status" = 'ACTIVE';

CREATE OR REPLACE FUNCTION t2t_guard_e_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'E-invoice records cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = NEW.document_id AND d.status = 'POSTED' AND d.kind IN ('INVOICE', 'CREDIT_NOTE')) THEN
      RAISE EXCEPTION 'An IRN can be recorded only for a posted invoice or credit note' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'CANCELLED' OR NEW.status <> 'CANCELLED'
     OR (NEW.org_id, NEW.document_id, NEW.irn, NEW.ack_no, NEW.ack_date, NEW.signed_qr_code, NEW.signed_invoice, NEW.signature_verified, NEW.payload_hash, NEW.created_by_id, NEW.created_at)
        IS DISTINCT FROM (OLD.org_id, OLD.document_id, OLD.irn, OLD.ack_no, OLD.ack_date, OLD.signed_qr_code, OLD.signed_invoice, OLD.signature_verified, OLD.payload_hash, OLD.created_by_id, OLD.created_at) THEN
    RAISE EXCEPTION 'An e-invoice record is immutable; only its cancellation can be recorded' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER e_invoices_guard BEFORE INSERT OR UPDATE OR DELETE ON "e_invoices" FOR EACH ROW EXECUTE FUNCTION t2t_guard_e_invoice();

-- A document with a live IRN cannot be voided in the books: cancel the IRN on the IRP first
-- (within 24 hours), or issue a credit note.
CREATE OR REPLACE FUNCTION t2t_guard_document_irn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'VOID' AND OLD.status <> 'VOID' AND EXISTS (SELECT 1 FROM e_invoices e WHERE e.document_id = NEW.id AND e.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'Document % has an IRN; cancel the IRN first or issue a credit note', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_irn_guard BEFORE UPDATE ON "documents" FOR EACH ROW EXECUTE FUNCTION t2t_guard_document_irn();

-- Row-level security, as for every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['e_invoice_settings', 'e_invoices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
