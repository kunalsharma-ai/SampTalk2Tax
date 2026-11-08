-- AR-025 dispute management: a customer's query about an invoice, its history and how it ended.
CREATE TABLE "invoice_disputes" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "document_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "reason" VARCHAR(20) NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    "owner_id" UUID,
    "target_date" DATE,
    "opened_on" DATE NOT NULL,
    "opened_by_id" UUID NOT NULL,
    "outcome" VARCHAR(20),
    "credit_note_id" UUID,
    "resolution_note" VARCHAR(1000),
    "resolved_on" DATE,
    "resolved_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "invoice_disputes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_disputes_id_org_id_key" ON "invoice_disputes"("id", "org_id");
CREATE UNIQUE INDEX "invoice_disputes_org_id_number_key" ON "invoice_disputes"("org_id", "number");
CREATE INDEX "invoice_disputes_org_id_status_idx" ON "invoice_disputes"("org_id", "status");
CREATE INDEX "invoice_disputes_document_id_idx" ON "invoice_disputes"("document_id");
-- One open dispute per invoice.
CREATE UNIQUE INDEX "invoice_disputes_one_open" ON "invoice_disputes"("document_id") WHERE "status" = 'OPEN';
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_credit_note_fk" FOREIGN KEY ("credit_note_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_opened_by_fk" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_resolved_by_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_chk" CHECK (
  amount > 0
  AND reason IN ('PRICE', 'QUANTITY', 'QUALITY', 'NOT_RECEIVED', 'DUPLICATE', 'TAX', 'OTHER')
  AND status IN ('OPEN', 'RESOLVED')
  AND (outcome IS NULL OR outcome IN ('CREDIT_NOTE', 'CUSTOMER_PAYS', 'WRITTEN_OFF', 'WITHDRAWN'))
  AND ((status = 'OPEN' AND outcome IS NULL AND resolved_on IS NULL AND resolved_by_id IS NULL AND credit_note_id IS NULL)
    OR (status = 'RESOLVED' AND outcome IS NOT NULL AND resolved_on IS NOT NULL AND resolved_by_id IS NOT NULL AND resolution_note IS NOT NULL))
  AND (credit_note_id IS NULL OR outcome = 'CREDIT_NOTE')
  AND (outcome IS DISTINCT FROM 'CREDIT_NOTE' OR credit_note_id IS NOT NULL)
);

-- A dispute is on a customer invoice, for that invoice's customer; a credit note that settles it is
-- the same customer's; once resolved it stays as it was.
CREATE FUNCTION t2t_check_invoice_dispute() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'RESOLVED' THEN
    RAISE EXCEPTION 'A resolved dispute cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.document_id <> OLD.document_id OR NEW.contact_id <> OLD.contact_id OR NEW.number <> OLD.number OR NEW.opened_on <> OLD.opened_on) THEN
    RAISE EXCEPTION 'A dispute stays on the invoice it was raised for' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = NEW.document_id AND d.org_id = NEW.org_id AND d.kind = 'INVOICE' AND d.contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'A dispute is for a customer invoice, raised for its customer' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.credit_note_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = NEW.credit_note_id AND d.org_id = NEW.org_id AND d.kind = 'CREDIT_NOTE' AND d.status = 'POSTED' AND d.contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'A dispute is settled by a posted credit note of the same customer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_disputes_check BEFORE INSERT OR UPDATE ON "invoice_disputes" FOR EACH ROW EXECUTE FUNCTION t2t_check_invoice_dispute();

CREATE TABLE "invoice_dispute_events" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "body" VARCHAR(2000),
    "data" JSONB,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_dispute_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "invoice_dispute_events_dispute_id_created_at_idx" ON "invoice_dispute_events"("dispute_id", "created_at");
ALTER TABLE "invoice_dispute_events" ADD CONSTRAINT "invoice_dispute_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_dispute_events" ADD CONSTRAINT "invoice_dispute_events_dispute_fk" FOREIGN KEY ("dispute_id", "org_id") REFERENCES "invoice_disputes"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_dispute_events" ADD CONSTRAINT "invoice_dispute_events_actor_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_dispute_events" ADD CONSTRAINT "invoice_dispute_events_chk" CHECK (kind IN ('RAISED', 'NOTE', 'CHANGED', 'RESOLVED'));

-- The history of a dispute is never rewritten.
CREATE FUNCTION t2t_invoice_dispute_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A dispute''s history cannot be changed' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER invoice_dispute_events_immutable BEFORE UPDATE ON "invoice_dispute_events" FOR EACH ROW EXECUTE FUNCTION t2t_invoice_dispute_events_immutable();

ALTER TABLE "invoice_disputes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_disputes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoice_disputes" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "invoice_dispute_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_dispute_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoice_dispute_events" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
