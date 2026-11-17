-- AR-017 Debit notes: an invoice that raises the value of an earlier posted invoice to the same
-- customer (GST: CGST Act s.34(3)). It is an INVOICE row (it is owed, aged and paid like one)
-- pointing at the invoice it adjusts, numbered in its own DN- series.
ALTER TABLE "documents" ADD COLUMN "debit_note_for_id" UUID;
ALTER TABLE "documents" ADD CONSTRAINT "documents_debit_note_for_fk"
  FOREIGN KEY ("debit_note_for_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_debit_note_kind"
  CHECK ("debit_note_for_id" IS NULL OR ("kind" = 'INVOICE' AND "debit_note_for_id" <> "id"));
CREATE INDEX "documents_org_id_debit_note_for_id_idx" ON "documents"("org_id", "debit_note_for_id");

-- The invoice adjusted must be a posted invoice (not itself a debit note) to the same customer in
-- the same currency, and the link cannot change once the debit note is posted.
CREATE OR REPLACE FUNCTION t2t_check_debit_note() RETURNS trigger AS $$
DECLARE o RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' AND NEW.debit_note_for_id IS DISTINCT FROM OLD.debit_note_for_id THEN
    RAISE EXCEPTION 'The invoice a posted debit note adjusts cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.debit_note_for_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.debit_note_for_id IS DISTINCT FROM OLD.debit_note_for_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.currency IS DISTINCT FROM OLD.currency) AND NEW.status <> 'VOID' THEN
    SELECT kind, status, contact_id, currency, debit_note_for_id INTO o FROM documents WHERE id = NEW.debit_note_for_id AND org_id = NEW.org_id;
    IF o.kind <> 'INVOICE' OR o.debit_note_for_id IS NOT NULL THEN
      RAISE EXCEPTION 'A debit note adjusts an invoice, not another debit note or a credit note' USING ERRCODE = 'P0001';
    END IF;
    IF o.status <> 'POSTED' THEN
      RAISE EXCEPTION 'A debit note can only adjust a posted invoice' USING ERRCODE = 'P0001';
    END IF;
    IF o.contact_id <> NEW.contact_id OR o.currency <> NEW.currency THEN
      RAISE EXCEPTION 'A debit note must be to the same customer and in the same currency as its invoice' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER documents_debit_note_check BEFORE INSERT OR UPDATE ON "documents" FOR EACH ROW EXECUTE FUNCTION t2t_check_debit_note();

-- An invoice cannot be voided while a debit note on it stands: void the debit note first.
CREATE OR REPLACE FUNCTION t2t_check_void_with_debit_notes() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'VOID' AND OLD.status = 'POSTED' THEN
    PERFORM 1 FROM documents WHERE debit_note_for_id = NEW.id AND org_id = NEW.org_id AND status <> 'VOID';
    IF FOUND THEN
      RAISE EXCEPTION 'Invoice % has debit notes; void them first', NEW.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER documents_void_debit_notes_check BEFORE UPDATE ON "documents" FOR EACH ROW EXECUTE FUNCTION t2t_check_void_with_debit_notes();
