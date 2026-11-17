-- AR-026 / AR-027: provisions for doubtful debts and bad-debt write-offs.
ALTER TYPE "JournalSource" ADD VALUE 'BAD_DEBT';
CREATE TYPE "WriteOffStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- The accounts and the provision matrix of an organisation.
CREATE TABLE "bad_debt_settings" (
    "org_id" UUID NOT NULL,
    "expense_account_id" UUID NOT NULL,
    "allowance_account_id" UUID NOT NULL,
    "rates" JSONB NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "bad_debt_settings_pkey" PRIMARY KEY ("org_id")
);

-- An invoice judged doubtful on its own: provided at its own percentage instead of its bucket's.
CREATE TABLE "doubtful_invoices" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "percent" DECIMAL(7,4) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "doubtful_invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bad_debt_write_offs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "document_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "exchange_rate" DECIMAL(24,10) NOT NULL,
    "functional_amount" DECIMAL(24,6) NOT NULL,
    "account_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "WriteOffStatus" NOT NULL DEFAULT 'ACTIVE',
    "journal_entry_id" UUID NOT NULL,
    "reversed_on" DATE,
    "reversal_reason" VARCHAR(500),
    "reversal_journal_entry_id" UUID,
    "reversed_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bad_debt_write_offs_pkey" PRIMARY KEY ("id")
);

-- Each provision run: the matrix used, what the receivables called for, what the books carried,
-- and the posting that closed the gap.
CREATE TABLE "bad_debt_provisions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "as_of" DATE NOT NULL,
    "rates" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "required" DECIMAL(24,6) NOT NULL,
    "carried" DECIMAL(24,6) NOT NULL,
    "adjustment" DECIMAL(24,6) NOT NULL,
    "journal_entry_id" UUID,
    "memo" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bad_debt_provisions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "allocations" ADD COLUMN "write_off_id" UUID;

CREATE UNIQUE INDEX "doubtful_invoices_document_id_key" ON "doubtful_invoices"("document_id");
CREATE INDEX "doubtful_invoices_org_id_idx" ON "doubtful_invoices"("org_id");
CREATE UNIQUE INDEX "bad_debt_write_offs_org_id_number_key" ON "bad_debt_write_offs"("org_id", "number");
CREATE UNIQUE INDEX "bad_debt_write_offs_id_org_id_key" ON "bad_debt_write_offs"("id", "org_id");
CREATE UNIQUE INDEX "bad_debt_write_offs_journal_entry_id_key" ON "bad_debt_write_offs"("journal_entry_id");
CREATE UNIQUE INDEX "bad_debt_write_offs_reversal_journal_entry_id_key" ON "bad_debt_write_offs"("reversal_journal_entry_id");
CREATE INDEX "bad_debt_write_offs_org_id_document_id_idx" ON "bad_debt_write_offs"("org_id", "document_id");
CREATE INDEX "bad_debt_write_offs_org_id_contact_id_idx" ON "bad_debt_write_offs"("org_id", "contact_id");
CREATE UNIQUE INDEX "bad_debt_provisions_org_id_number_key" ON "bad_debt_provisions"("org_id", "number");
CREATE UNIQUE INDEX "bad_debt_provisions_journal_entry_id_key" ON "bad_debt_provisions"("journal_entry_id");
CREATE INDEX "allocations_org_id_write_off_id_idx" ON "allocations"("org_id", "write_off_id");

ALTER TABLE "bad_debt_settings" ADD CONSTRAINT "bad_debt_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_settings" ADD CONSTRAINT "bad_debt_settings_expense_fk" FOREIGN KEY ("expense_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_settings" ADD CONSTRAINT "bad_debt_settings_allowance_fk" FOREIGN KEY ("allowance_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_settings" ADD CONSTRAINT "bad_debt_settings_updated_by_fk" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "doubtful_invoices" ADD CONSTRAINT "doubtful_invoices_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "doubtful_invoices" ADD CONSTRAINT "doubtful_invoices_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_write_offs" ADD CONSTRAINT "bad_debt_write_offs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_write_offs" ADD CONSTRAINT "bad_debt_write_offs_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_write_offs" ADD CONSTRAINT "bad_debt_write_offs_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_write_offs" ADD CONSTRAINT "bad_debt_write_offs_account_fk" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_write_offs" ADD CONSTRAINT "bad_debt_write_offs_journal_fk" FOREIGN KEY ("journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_write_offs" ADD CONSTRAINT "bad_debt_write_offs_reversal_fk" FOREIGN KEY ("reversal_journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_write_offs" ADD CONSTRAINT "bad_debt_write_offs_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_write_offs" ADD CONSTRAINT "bad_debt_write_offs_reversed_by_fk" FOREIGN KEY ("reversed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_provisions" ADD CONSTRAINT "bad_debt_provisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_provisions" ADD CONSTRAINT "bad_debt_provisions_journal_fk" FOREIGN KEY ("journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bad_debt_provisions" ADD CONSTRAINT "bad_debt_provisions_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_write_off_fk" FOREIGN KEY ("write_off_id", "org_id") REFERENCES "bad_debt_write_offs"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bad_debt_settings" ADD CONSTRAINT "bad_debt_settings_chk" CHECK (expense_account_id <> allowance_account_id AND jsonb_typeof(rates) = 'object');
ALTER TABLE "doubtful_invoices" ADD CONSTRAINT "doubtful_invoices_chk" CHECK (percent > 0 AND percent <= 100);
ALTER TABLE "bad_debt_write_offs" ADD CONSTRAINT "bad_debt_write_offs_chk" CHECK (
  number > 0 AND amount > 0 AND functional_amount > 0 AND exchange_rate > 0
  AND ((status = 'REVERSED') = (reversed_on IS NOT NULL AND reversal_journal_entry_id IS NOT NULL AND reversal_reason IS NOT NULL AND reversed_by_id IS NOT NULL))
  AND (reversed_on IS NULL OR reversed_on >= date)
);
ALTER TABLE "bad_debt_provisions" ADD CONSTRAINT "bad_debt_provisions_chk" CHECK (
  number > 0 AND required >= 0 AND carried >= 0 AND adjustment = required - carried
  AND ((adjustment = 0) = (journal_entry_id IS NULL))
);
ALTER TABLE "allocations" DROP CONSTRAINT "allocations_one_source_chk";
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_one_source_chk" CHECK (num_nonnulls(payment_id, credit_document_id, write_off_id) = 1);

-- A write-off keeps its figures; the only change is being reversed once.
CREATE FUNCTION t2t_guard_write_off() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A write-off cannot be deleted; reverse it instead' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'REVERSED' OR NEW.status <> 'REVERSED'
     OR (NEW.org_id, NEW.number, NEW.document_id, NEW.contact_id, NEW.date, NEW.currency, NEW.amount, NEW.exchange_rate, NEW.functional_amount, NEW.account_id, NEW.reason, NEW.journal_entry_id, NEW.created_by_id)
        IS DISTINCT FROM (OLD.org_id, OLD.number, OLD.document_id, OLD.contact_id, OLD.date, OLD.currency, OLD.amount, OLD.exchange_rate, OLD.functional_amount, OLD.account_id, OLD.reason, OLD.journal_entry_id, OLD.created_by_id) THEN
    RAISE EXCEPTION 'A write-off is immutable apart from being reversed once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bad_debt_write_offs_guard BEFORE UPDATE OR DELETE ON "bad_debt_write_offs" FOR EACH ROW EXECUTE FUNCTION t2t_guard_write_off();

CREATE FUNCTION t2t_guard_bad_debt_provision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A bad-debt provision run is append-only; run a new one to change the allowance' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER bad_debt_provisions_guard BEFORE UPDATE OR DELETE ON "bad_debt_provisions" FOR EACH ROW EXECUTE FUNCTION t2t_guard_bad_debt_provision();

-- Allocations: the write-off source joins the immutable columns.
CREATE OR REPLACE FUNCTION t2t_guard_allocation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Allocation % cannot be deleted; remove it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.removed_on IS NOT NULL OR NEW.removed_on IS NULL
     OR (NEW.target_id, NEW.payment_id, NEW.credit_document_id, NEW.write_off_id, NEW.amount, NEW.date, NEW.fx_gain, NEW.fx_journal_entry_id)
        IS DISTINCT FROM (OLD.target_id, OLD.payment_id, OLD.credit_document_id, OLD.write_off_id, OLD.amount, OLD.date, OLD.fx_gain, OLD.fx_journal_entry_id)
     OR (OLD.fx_journal_entry_id IS NOT NULL AND NEW.fx_reversal_journal_entry_id IS NULL) THEN
    RAISE EXCEPTION 'Allocation % is immutable apart from being removed once', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- At commit: a write-off settles only an invoice of its own customer, in its currency, while active.
CREATE OR REPLACE FUNCTION t2t_check_allocation() RETURNS trigger AS $$
DECLARE
  t record;
  s_contact uuid;
  s_kind text;
  s_status text;
  s_total numeric;
  s_currency text;
  used numeric;
BEGIN
  SELECT kind::text AS kind, status::text AS status, contact_id, total, currency INTO t FROM documents WHERE id = NEW.target_id;
  IF t.kind NOT IN ('INVOICE', 'BILL') THEN
    RAISE EXCEPTION 'Allocations can only settle invoices or bills' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.payment_id IS NOT NULL THEN
    SELECT contact_id, kind::text, status::text, amount, currency INTO s_contact, s_kind, s_status, s_total, s_currency FROM payments WHERE id = NEW.payment_id;
    IF (t.kind = 'INVOICE') <> (s_kind = 'RECEIPT') THEN
      RAISE EXCEPTION 'Receipts settle invoices and payments settle bills' USING ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO used FROM allocations WHERE payment_id = NEW.payment_id AND removed_on IS NULL;
  ELSIF NEW.write_off_id IS NOT NULL THEN
    SELECT w.contact_id, 'WRITE_OFF', CASE WHEN w.status = 'ACTIVE' THEN 'POSTED' ELSE 'VOID' END, w.amount, w.currency
      INTO s_contact, s_kind, s_status, s_total, s_currency FROM bad_debt_write_offs w WHERE w.id = NEW.write_off_id;
    IF t.kind <> 'INVOICE' OR NOT EXISTS (SELECT 1 FROM bad_debt_write_offs w WHERE w.id = NEW.write_off_id AND w.document_id = NEW.target_id) THEN
      RAISE EXCEPTION 'A write-off settles only the invoice it was made for' USING ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO used FROM allocations WHERE write_off_id = NEW.write_off_id AND removed_on IS NULL;
  ELSE
    SELECT contact_id, kind::text, status::text, total, currency INTO s_contact, s_kind, s_status, s_total, s_currency FROM documents WHERE id = NEW.credit_document_id;
    IF (t.kind = 'INVOICE') <> (s_kind = 'CREDIT_NOTE') OR s_kind NOT IN ('CREDIT_NOTE', 'VENDOR_CREDIT') THEN
      RAISE EXCEPTION 'Credit notes settle invoices and vendor credits settle bills' USING ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO used FROM allocations WHERE credit_document_id = NEW.credit_document_id AND removed_on IS NULL;
  END IF;
  IF s_currency <> t.currency THEN
    RAISE EXCEPTION 'Allocation source and target are in different currencies (% and %)', s_currency, t.currency USING ERRCODE = 'P0001';
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

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bad_debt_settings', 'doubtful_invoices', 'bad_debt_write_offs', 'bad_debt_provisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
