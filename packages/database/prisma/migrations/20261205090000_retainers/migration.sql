-- AR-015 retainer billing: money a customer keeps on account at an agreed level, held as receipts
-- not yet applied and drawn down onto invoices.
CREATE TABLE "retainers" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "contact_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "minimum_balance" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "start_date" DATE NOT NULL,
    "terms" VARCHAR(2000),
    "status" VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    "closed_at" TIMESTAMPTZ(6),
    "close_reason" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "retainers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "retainers_org_id_number_key" ON "retainers"("org_id", "number");
CREATE UNIQUE INDEX "retainers_id_org_id_key" ON "retainers"("id", "org_id");
CREATE INDEX "retainers_org_id_contact_id_idx" ON "retainers"("org_id", "contact_id");
ALTER TABLE "retainers" ADD CONSTRAINT "retainers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "retainers" ADD CONSTRAINT "retainers_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "retainers" ADD CONSTRAINT "retainers_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "retainers" ADD CONSTRAINT "retainers_chk" CHECK (
  status IN ('ACTIVE', 'CLOSED')
  AND amount > 0 AND minimum_balance >= 0 AND minimum_balance <= amount
  AND length(btrim(name)) > 0
  AND (status = 'CLOSED') = (closed_at IS NOT NULL)
);

-- The receipts that make up a retainer. A receipt belongs to at most one retainer, for ever.
CREATE TABLE "retainer_receipts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "retainer_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "retainer_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "retainer_receipts_payment_id_key" ON "retainer_receipts"("payment_id");
CREATE INDEX "retainer_receipts_org_id_retainer_id_idx" ON "retainer_receipts"("org_id", "retainer_id");
ALTER TABLE "retainer_receipts" ADD CONSTRAINT "retainer_receipts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "retainer_receipts" ADD CONSTRAINT "retainer_receipts_retainer_fk" FOREIGN KEY ("retainer_id", "org_id") REFERENCES "retainers"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "retainer_receipts" ADD CONSTRAINT "retainer_receipts_payment_fk" FOREIGN KEY ("payment_id", "org_id") REFERENCES "payments"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "retainer_receipts" ADD CONSTRAINT "retainer_receipts_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A closed retainer stays closed and keeps its customer; terms can change while it is active.
CREATE FUNCTION t2t_check_retainer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A retainer cannot be deleted; close it instead' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'This retainer is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'A retainer keeps its customer and number' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retainers_check BEFORE UPDATE OR DELETE ON "retainers" FOR EACH ROW EXECUTE FUNCTION t2t_check_retainer();

-- A retainer receipt is a customer receipt of the retainer's customer, added while it is active,
-- and the link is never changed or removed (voiding the receipt takes it out of the balance).
CREATE FUNCTION t2t_check_retainer_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  p RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A retainer receipt cannot be changed or removed; void the receipt instead' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, contact_id INTO r FROM retainers WHERE id = NEW.retainer_id;
  SELECT kind::text AS kind, contact_id, status::text AS status INTO p FROM payments WHERE id = NEW.payment_id;
  IF r.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'This retainer is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF p.kind <> 'RECEIPT' OR p.contact_id <> r.contact_id OR p.status <> 'POSTED' THEN
    RAISE EXCEPTION 'A retainer receipt must be a posted receipt from the retainer''s customer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retainer_receipts_check BEFORE INSERT OR UPDATE OR DELETE ON "retainer_receipts" FOR EACH ROW EXECUTE FUNCTION t2t_check_retainer_receipt();

ALTER TABLE "retainers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "retainers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "retainers" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "retainer_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "retainer_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "retainer_receipts" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
