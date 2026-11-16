-- AP-007 payment scheduling: the date (and amount) a bill is planned to be paid.
CREATE TABLE "bill_payment_plans" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "pay_date" DATE NOT NULL,
    "amount" DECIMAL(24,6),
    "note" VARCHAR(300),
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "bill_payment_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bill_payment_plans_document_id_key" ON "bill_payment_plans"("document_id");
CREATE INDEX "bill_payment_plans_org_id_pay_date_idx" ON "bill_payment_plans"("org_id", "pay_date");
ALTER TABLE "bill_payment_plans" ADD CONSTRAINT "bill_payment_plans_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bill_payment_plans" ADD CONSTRAINT "bill_payment_plans_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bill_payment_plans" ADD CONSTRAINT "bill_payment_plans_updated_by_fk" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bill_payment_plans" ADD CONSTRAINT "bill_payment_plans_chk" CHECK (amount IS NULL OR amount > 0);

-- Only a bill is planned for payment.
CREATE FUNCTION t2t_check_bill_payment_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = NEW.document_id AND d.org_id = NEW.org_id AND d.kind = 'BILL') THEN
    RAISE EXCEPTION 'A payment plan is for a vendor bill' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bill_payment_plans_check BEFORE INSERT OR UPDATE ON "bill_payment_plans" FOR EACH ROW EXECUTE FUNCTION t2t_check_bill_payment_plan();

ALTER TABLE "bill_payment_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bill_payment_plans" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "bill_payment_plans" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
