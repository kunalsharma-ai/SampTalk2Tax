-- Invoices, bills, credit notes, receipts and payments in a foreign currency, and realised
-- exchange gains and losses when they are settled at a different rate.

ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'FX_SETTLEMENT';

-- Functional currency per one unit of the document's currency (1 in the functional currency).
ALTER TABLE documents ADD COLUMN exchange_rate numeric(24,10) NOT NULL DEFAULT 1;
ALTER TABLE documents ADD CONSTRAINT documents_exchange_rate_positive CHECK (exchange_rate > 0);
ALTER TABLE payments ADD COLUMN exchange_rate numeric(24,10) NOT NULL DEFAULT 1;
ALTER TABLE payments ADD CONSTRAINT payments_exchange_rate_positive CHECK (exchange_rate > 0);

-- The realised exchange difference posted when the allocation was made, and its reversal when removed.
ALTER TABLE allocations ADD COLUMN fx_gain numeric(24,6) NOT NULL DEFAULT 0;
ALTER TABLE allocations ADD COLUMN fx_journal_entry_id uuid UNIQUE;
ALTER TABLE allocations ADD COLUMN fx_reversal_journal_entry_id uuid UNIQUE;
ALTER TABLE allocations ADD CONSTRAINT allocations_fx_journal_fk FOREIGN KEY (fx_journal_entry_id, org_id) REFERENCES journal_entries(id, org_id) ON DELETE RESTRICT;
ALTER TABLE allocations ADD CONSTRAINT allocations_fx_reversal_fk FOREIGN KEY (fx_reversal_journal_entry_id, org_id) REFERENCES journal_entries(id, org_id) ON DELETE RESTRICT;
ALTER TABLE allocations ADD CONSTRAINT allocations_fx_journal_check CHECK ((fx_gain = 0) = (fx_journal_entry_id IS NULL));
ALTER TABLE allocations ADD CONSTRAINT allocations_fx_reversal_check CHECK (fx_reversal_journal_entry_id IS NULL OR (removed_on IS NOT NULL AND fx_journal_entry_id IS NOT NULL));

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
  IF OLD.status = 'POSTED' AND NEW.status = 'POSTED'
     AND (to_jsonb(NEW) - 'template_id' - 'updated_at') = (to_jsonb(OLD) - 'template_id' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'POSTED' THEN
    IF NEW.status <> 'VOID'
       OR (NEW.kind, NEW.number, NEW.contact_id, NEW.issue_date, NEW.due_date, NEW.currency, NEW.subtotal, NEW.tax_total, NEW.total, NEW.journal_entry_id, NEW.reference,
           NEW.place_of_supply, NEW.supplier_state, NEW.supply_nature, NEW.counterparty_gstin,
           NEW.reverse_charge, NEW.reverse_charge_tax, NEW.withholding_section_id, NEW.withholding_kind, NEW.withholding_subject, NEW.withholding_base,
           NEW.withholding_rate, NEW.withholding_amount, NEW.counterparty_pan, NEW.exchange_rate)
          IS DISTINCT FROM
          (OLD.kind, OLD.number, OLD.contact_id, OLD.issue_date, OLD.due_date, OLD.currency, OLD.subtotal, OLD.tax_total, OLD.total, OLD.journal_entry_id, OLD.reference,
           OLD.place_of_supply, OLD.supplier_state, OLD.supply_nature, OLD.counterparty_gstin,
           OLD.reverse_charge, OLD.reverse_charge_tax, OLD.withholding_section_id, OLD.withholding_kind, OLD.withholding_subject, OLD.withholding_base,
           OLD.withholding_rate, OLD.withholding_amount, OLD.counterparty_pan, OLD.exchange_rate) THEN
      RAISE EXCEPTION 'Posted document % is immutable; void it and issue a new one', OLD.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION t2t_guard_payment() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment % cannot be deleted; void it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'VOID'
     OR NEW.status <> 'VOID'
     OR (NEW.kind, NEW.number, NEW.contact_id, NEW.date, NEW.bank_account_id, NEW.currency, NEW.amount, NEW.journal_entry_id, NEW.exchange_rate)
        IS DISTINCT FROM
        (OLD.kind, OLD.number, OLD.contact_id, OLD.date, OLD.bank_account_id, OLD.currency, OLD.amount, OLD.journal_entry_id, OLD.exchange_rate) THEN
    RAISE EXCEPTION 'Payment % is immutable; void it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Allocations are never deleted; the only change allowed is stamping removal once (with the
-- reversal of its exchange difference, if it had one).
CREATE OR REPLACE FUNCTION t2t_guard_allocation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Allocation % cannot be deleted; remove it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.removed_on IS NOT NULL OR NEW.removed_on IS NULL
     OR (NEW.target_id, NEW.payment_id, NEW.credit_document_id, NEW.amount, NEW.date, NEW.fx_gain, NEW.fx_journal_entry_id)
        IS DISTINCT FROM (OLD.target_id, OLD.payment_id, OLD.credit_document_id, OLD.amount, OLD.date, OLD.fx_gain, OLD.fx_journal_entry_id)
     OR (OLD.fx_journal_entry_id IS NOT NULL AND NEW.fx_reversal_journal_entry_id IS NULL) THEN
    RAISE EXCEPTION 'Allocation % is immutable apart from being removed once', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- At commit, an allocation must also link records in the same currency.
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

