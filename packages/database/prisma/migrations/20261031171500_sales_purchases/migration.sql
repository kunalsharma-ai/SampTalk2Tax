-- CreateEnum
CREATE TYPE "JournalSource" AS ENUM ('MANUAL', 'DOCUMENT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('INVOICE', 'CREDIT_NOTE', 'BILL', 'VENDOR_CREDIT');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'POSTED', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('RECEIPT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('POSTED', 'VOID');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "ap_account_id" UUID,
ADD COLUMN     "ar_account_id" UUID;

-- AlterTable
ALTER TABLE "journal_entries" ADD COLUMN     "source" "JournalSource" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "tax_id" TEXT,
    "address" TEXT,
    "is_customer" BOOLEAN NOT NULL DEFAULT false,
    "is_vendor" BOOLEAN NOT NULL DEFAULT false,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "credit_limit" DECIMAL(24,6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(9,6) NOT NULL,
    "sales_account_id" UUID,
    "purchase_account_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "number" TEXT,
    "contact_id" UUID NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "reference" TEXT,
    "memo" TEXT,
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(24,6) NOT NULL,
    "tax_total" DECIMAL(24,6) NOT NULL,
    "total" DECIMAL(24,6) NOT NULL,
    "journal_entry_id" UUID,
    "void_journal_entry_id" UUID,
    "void_date" DATE,
    "void_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "posted_by_id" UUID,
    "posted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" TEXT,
    "account_id" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "unit_price" DECIMAL(24,6) NOT NULL,
    "tax_rate_id" UUID,
    "tax_rate" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "net_amount" DECIMAL(24,6) NOT NULL,
    "tax_amount" DECIMAL(24,6) NOT NULL,

    CONSTRAINT "document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'POSTED',
    "number" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "reference" TEXT,
    "memo" TEXT,
    "journal_entry_id" UUID NOT NULL,
    "void_journal_entry_id" UUID,
    "void_date" DATE,
    "idempotency_key" TEXT,
    "idempotency_hash" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "payment_id" UUID,
    "credit_document_id" UUID,
    "amount" DECIMAL(24,6) NOT NULL,
    "date" DATE NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_on" DATE,
    "removed_by_id" UUID,

    CONSTRAINT "allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contacts_org_id_name_idx" ON "contacts"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_id_org_id_key" ON "contacts"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_org_id_name_key" ON "tax_rates"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_id_org_id_key" ON "tax_rates"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_journal_entry_id_key" ON "documents"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_void_journal_entry_id_key" ON "documents"("void_journal_entry_id");

-- CreateIndex
CREATE INDEX "documents_org_id_kind_status_idx" ON "documents"("org_id", "kind", "status");

-- CreateIndex
CREATE INDEX "documents_org_id_contact_id_idx" ON "documents"("org_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_org_id_kind_number_key" ON "documents"("org_id", "kind", "number");

-- CreateIndex
CREATE UNIQUE INDEX "documents_id_org_id_key" ON "documents"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_lines_document_id_line_no_key" ON "document_lines"("document_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "payments_journal_entry_id_key" ON "payments"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_void_journal_entry_id_key" ON "payments"("void_journal_entry_id");

-- CreateIndex
CREATE INDEX "payments_org_id_contact_id_idx" ON "payments"("org_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_org_id_kind_number_key" ON "payments"("org_id", "kind", "number");

-- CreateIndex
CREATE UNIQUE INDEX "payments_org_id_idempotency_key_key" ON "payments"("org_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payments_id_org_id_key" ON "payments"("id", "org_id");

-- CreateIndex
CREATE INDEX "allocations_org_id_target_id_idx" ON "allocations"("org_id", "target_id");

-- CreateIndex
CREATE INDEX "allocations_org_id_payment_id_idx" ON "allocations"("org_id", "payment_id");

-- CreateIndex
CREATE INDEX "allocations_org_id_credit_document_id_idx" ON "allocations"("org_id", "credit_document_id");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_contact_id_org_id_fkey" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_document_id_org_id_fkey" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_account_id_org_id_fkey" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_tax_rate_id_org_id_fkey" FOREIGN KEY ("tax_rate_id", "org_id") REFERENCES "tax_rates"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_contact_id_org_id_fkey" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bank_account_id_org_id_fkey" FOREIGN KEY ("bank_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_target_id_org_id_fkey" FOREIGN KEY ("target_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_payment_id_org_id_fkey" FOREIGN KEY ("payment_id", "org_id") REFERENCES "payments"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_credit_document_id_org_id_fkey" FOREIGN KEY ("credit_document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =====================================================================
-- Hand-written integrity rules for sales and purchases (Directive Parts 6, 7, 50).
-- =====================================================================

-- Control accounts and journal links stay inside the tenant.
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_ar_account_fk" FOREIGN KEY ("ar_account_id", "id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "organizations_ap_account_fk" FOREIGN KEY ("ap_account_id", "id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT;
ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_sales_account_fk" FOREIGN KEY ("sales_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "tax_rates_purchase_account_fk" FOREIGN KEY ("purchase_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "tax_rates_rate_chk" CHECK ("rate" >= 0 AND "rate" <= 100);
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_journal_fk" FOREIGN KEY ("journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "documents_void_journal_fk" FOREIGN KEY ("void_journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "documents_amounts_chk" CHECK ("total" = "subtotal" + "tax_total" AND "total" > 0 AND "subtotal" >= 0 AND "tax_total" >= 0),
  ADD CONSTRAINT "documents_dates_chk" CHECK ("due_date" >= "issue_date"),
  ADD CONSTRAINT "documents_status_fields_chk" CHECK (
    ("status" = 'DRAFT' AND "number" IS NULL AND "journal_entry_id" IS NULL)
    OR ("status" = 'POSTED' AND "number" IS NOT NULL AND "journal_entry_id" IS NOT NULL AND "void_journal_entry_id" IS NULL)
    OR ("status" = 'VOID' AND "number" IS NOT NULL AND "journal_entry_id" IS NOT NULL AND "void_journal_entry_id" IS NOT NULL AND "void_date" IS NOT NULL)
  );
ALTER TABLE "document_lines"
  ADD CONSTRAINT "document_lines_amounts_chk" CHECK ("quantity" > 0 AND "unit_price" >= 0 AND "net_amount" >= 0 AND "tax_amount" >= 0);
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_journal_fk" FOREIGN KEY ("journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payments_void_journal_fk" FOREIGN KEY ("void_journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payments_amount_chk" CHECK ("amount" > 0),
  ADD CONSTRAINT "payments_void_chk" CHECK (("status" = 'POSTED') = ("void_journal_entry_id" IS NULL));
ALTER TABLE "allocations"
  ADD CONSTRAINT "allocations_amount_chk" CHECK ("amount" > 0),
  ADD CONSTRAINT "allocations_one_source_chk" CHECK (("payment_id" IS NULL) <> ("credit_document_id" IS NULL));
ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_role_chk" CHECK ("is_customer" OR "is_vendor"),
  ADD CONSTRAINT "contacts_terms_chk" CHECK ("payment_terms_days" BETWEEN 0 AND 3650),
  ADD CONSTRAINT "contacts_credit_limit_chk" CHECK ("credit_limit" IS NULL OR "credit_limit" >= 0);

-- A supplier's invoice number can only be entered once per vendor (duplicate bill detection).
CREATE UNIQUE INDEX "documents_bill_reference_uniq" ON "documents" ("org_id", "contact_id", lower("reference"))
  WHERE "kind" = 'BILL' AND "status" <> 'VOID' AND "reference" IS NOT NULL;

-- Existing organisations: use the template receivables/payables accounts as control accounts.
UPDATE "organizations" o SET "ar_account_id" = (
  SELECT a.id FROM "accounts" a WHERE a.org_id = o.id AND a.subtype = 'ACCOUNTS_RECEIVABLE' AND a.is_postable ORDER BY a.code LIMIT 1);
UPDATE "organizations" o SET "ap_account_id" = (
  SELECT a.id FROM "accounts" a WHERE a.org_id = o.id AND a.subtype = 'ACCOUNTS_PAYABLE' AND a.is_postable ORDER BY a.code LIMIT 1);

-- Manual journals cannot touch the control accounts: their balances must always equal
-- the open documents and unapplied payments behind them.
CREATE OR REPLACE FUNCTION t2t_check_control_account() RETURNS trigger AS $$
DECLARE
  src "JournalSource";
  ar uuid;
  ap uuid;
BEGIN
  SELECT source INTO src FROM journal_entries WHERE id = NEW.entry_id;
  IF src = 'MANUAL' THEN
    SELECT ar_account_id, ap_account_id INTO ar, ap FROM organizations WHERE id = NEW.org_id;
    IF NEW.account_id = ar OR NEW.account_id = ap THEN
      RAISE EXCEPTION 'Account % is a receivables/payables control account; Cannot post a manual journal to it', NEW.account_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_lines_control_account_check
  BEFORE INSERT OR UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION t2t_check_control_account();

-- Posted documents are immutable apart from being voided once.
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
       OR (NEW.kind, NEW.number, NEW.contact_id, NEW.issue_date, NEW.due_date, NEW.currency, NEW.subtotal, NEW.tax_total, NEW.total, NEW.journal_entry_id, NEW.reference)
          IS DISTINCT FROM
          (OLD.kind, OLD.number, OLD.contact_id, OLD.issue_date, OLD.due_date, OLD.currency, OLD.subtotal, OLD.tax_total, OLD.total, OLD.journal_entry_id, OLD.reference) THEN
      RAISE EXCEPTION 'Posted document % is immutable; void it and issue a new one', OLD.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_guard
  BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_document();

CREATE OR REPLACE FUNCTION t2t_guard_document_line() RETURNS trigger AS $$
DECLARE
  d_status "DocumentStatus";
  target uuid;
BEGIN
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
  SELECT status INTO d_status FROM documents WHERE id = target;
  IF d_status IS NOT NULL AND d_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of posted document % are immutable', target USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON document_lines
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_document_line();

-- Payments are immutable apart from being voided once, and are never deleted.
CREATE OR REPLACE FUNCTION t2t_guard_payment() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment % cannot be deleted; void it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'VOID'
     OR NEW.status <> 'VOID'
     OR (NEW.kind, NEW.number, NEW.contact_id, NEW.date, NEW.bank_account_id, NEW.currency, NEW.amount, NEW.journal_entry_id)
        IS DISTINCT FROM
        (OLD.kind, OLD.number, OLD.contact_id, OLD.date, OLD.bank_account_id, OLD.currency, OLD.amount, OLD.journal_entry_id) THEN
    RAISE EXCEPTION 'Payment % is immutable; void it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_guard
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_payment();

-- Allocations are never deleted; the only change allowed is stamping removal once.
CREATE OR REPLACE FUNCTION t2t_guard_allocation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Allocation % cannot be deleted; remove it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.removed_on IS NOT NULL OR NEW.removed_on IS NULL
     OR (NEW.target_id, NEW.payment_id, NEW.credit_document_id, NEW.amount, NEW.date)
        IS DISTINCT FROM (OLD.target_id, OLD.payment_id, OLD.credit_document_id, OLD.amount, OLD.date) THEN
    RAISE EXCEPTION 'Allocation % is immutable apart from being removed once', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER allocations_guard
  BEFORE UPDATE OR DELETE ON allocations
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_allocation();

-- At commit, an allocation must link posted records of the same contact and ledger,
-- and nothing may be allocated beyond its total.
CREATE OR REPLACE FUNCTION t2t_check_allocation() RETURNS trigger AS $$
DECLARE
  t record;
  s_contact uuid;
  s_kind text;
  s_status text;
  s_total numeric;
  used numeric;
BEGIN
  SELECT kind::text AS kind, status::text AS status, contact_id, total INTO t FROM documents WHERE id = NEW.target_id;
  IF t.kind NOT IN ('INVOICE', 'BILL') THEN
    RAISE EXCEPTION 'Allocations can only settle invoices or bills' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.payment_id IS NOT NULL THEN
    SELECT contact_id, kind::text, status::text, amount INTO s_contact, s_kind, s_status, s_total FROM payments WHERE id = NEW.payment_id;
    IF (t.kind = 'INVOICE') <> (s_kind = 'RECEIPT') THEN
      RAISE EXCEPTION 'Receipts settle invoices and payments settle bills' USING ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO used FROM allocations WHERE payment_id = NEW.payment_id AND removed_on IS NULL;
  ELSE
    SELECT contact_id, kind::text, status::text, total INTO s_contact, s_kind, s_status, s_total FROM documents WHERE id = NEW.credit_document_id;
    IF (t.kind = 'INVOICE') <> (s_kind = 'CREDIT_NOTE') OR s_kind NOT IN ('CREDIT_NOTE', 'VENDOR_CREDIT') THEN
      RAISE EXCEPTION 'Credit notes settle invoices and vendor credits settle bills' USING ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO used FROM allocations WHERE credit_document_id = NEW.credit_document_id AND removed_on IS NULL;
  END IF;
  IF s_contact <> t.contact_id THEN
    RAISE EXCEPTION 'Allocation source and target belong to different contacts' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.removed_on IS NULL AND (t.status <> 'POSTED' OR s_status <> 'POSTED') THEN
    RAISE EXCEPTION 'Allocations need posted documents and payments' USING ERRCODE = 'P0001';
  END IF;
  IF used > s_total THEN
    RAISE EXCEPTION 'Allocations exceed the source amount (% > %)', used, s_total USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO used FROM allocations WHERE target_id = NEW.target_id AND removed_on IS NULL;
  IF used > t.total THEN
    RAISE EXCEPTION 'Allocations exceed the document total (% > %)', used, t.total USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER allocations_checked
  AFTER INSERT ON allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION t2t_check_allocation();

-- A document or payment cannot be voided while allocations still use it.
CREATE OR REPLACE FUNCTION t2t_check_void_unallocated() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'VOID' AND OLD.status <> 'VOID' THEN
    IF TG_TABLE_NAME = 'documents' THEN
      PERFORM 1 FROM allocations WHERE (target_id = NEW.id OR credit_document_id = NEW.id) AND removed_on IS NULL;
    ELSE
      PERFORM 1 FROM allocations WHERE payment_id = NEW.id AND removed_on IS NULL;
    END IF;
    IF FOUND THEN
      RAISE EXCEPTION 'Cannot void % while allocations use it; remove them first', NEW.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_void_check BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION t2t_check_void_unallocated();
CREATE TRIGGER payments_void_check BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION t2t_check_void_unallocated();
