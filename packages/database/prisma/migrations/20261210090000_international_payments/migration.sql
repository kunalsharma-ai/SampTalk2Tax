-- AP-023 international payment preparation: a vendor's bank account abroad, and outward remittances
-- prepared, approved by a second person and sent by the bank, then recorded at the bank's rate.

-- A vendor's bank details are either domestic (IFSC) or international (SWIFT/BIC, IBAN or account
-- number, bank country, a routing code where the country needs one).
ALTER TABLE "vendor_bank_details"
  ADD COLUMN "kind" VARCHAR(13) NOT NULL DEFAULT 'DOMESTIC',
  ADD COLUMN "swift_bic" VARCHAR(11),
  ADD COLUMN "bank_country" CHAR(2),
  ADD COLUMN "bank_address" VARCHAR(300),
  ADD COLUMN "routing_code" VARCHAR(20),
  ADD COLUMN "intermediary_swift" VARCHAR(11),
  ALTER COLUMN "ifsc" DROP NOT NULL;
ALTER TABLE "vendor_bank_details" ADD CONSTRAINT "vendor_bank_details_kind_chk" CHECK (
  (kind = 'DOMESTIC' AND ifsc IS NOT NULL AND swift_bic IS NULL AND bank_country IS NULL)
  OR (kind = 'INTERNATIONAL' AND ifsc IS NULL AND swift_bic IS NOT NULL AND bank_country IS NOT NULL)
);

CREATE OR REPLACE FUNCTION t2t_guard_vendor_bank_details() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Vendor bank details cannot be deleted; replace them instead' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.account_name, NEW.account_number, NEW.ifsc, NEW.bank_name, NEW.kind, NEW.swift_bic, NEW.bank_country, NEW.bank_address, NEW.routing_code, NEW.intermediary_swift)
     IS DISTINCT FROM (OLD.account_name, OLD.account_number, OLD.ifsc, OLD.bank_name, OLD.kind, OLD.swift_bic, OLD.bank_country, OLD.bank_address, OLD.routing_code, OLD.intermediary_swift) THEN
    -- New details are never verified by the same write.
    NEW.verified_by_id := NULL;
    NEW.verified_at := NULL;
    NEW.verification_note := NULL;
  ELSIF NEW.verified_by_id IS NOT NULL AND NEW.verified_by_id = NEW.changed_by_id AND current_setting('t2t.allow_self_verify', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Bank details must be verified by someone other than the person who changed them' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- An outward remittance to one vendor in their currency, settling some of their bills (IP-0001).
CREATE TABLE "international_payments" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "contact_id" UUID NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "payment_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "estimate_rate" DECIMAL(24,10),
    "purpose_code" VARCHAR(5),
    "purpose" VARCHAR(200),
    "charges" VARCHAR(3) NOT NULL DEFAULT 'OUR',
    "taxable_in_india" BOOLEAN NOT NULL DEFAULT true,
    "has_tax_order" BOOLEAN NOT NULL DEFAULT false,
    "form15_part" VARCHAR(4) NOT NULL DEFAULT 'NONE',
    "needs_15cb" BOOLEAN NOT NULL DEFAULT false,
    "form15ca_ack" VARCHAR(40),
    "form15cb_number" VARCHAR(40),
    "memo" VARCHAR(500),
    "status" VARCHAR(10) NOT NULL DEFAULT 'DRAFT',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "sent_by_id" UUID,
    "sent_at" TIMESTAMPTZ(6),
    "paid_rate" DECIMAL(24,10),
    "bank_reference" VARCHAR(60),
    "payment_id" UUID,
    "paid_by_id" UUID,
    "paid_at" TIMESTAMPTZ(6),
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" VARCHAR(500),
    CONSTRAINT "international_payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "international_payments_id_org_id_key" ON "international_payments"("id", "org_id");
CREATE UNIQUE INDEX "international_payments_org_id_number_key" ON "international_payments"("org_id", "number");
CREATE INDEX "international_payments_org_id_status_idx" ON "international_payments"("org_id", "status");
ALTER TABLE "international_payments" ADD CONSTRAINT "international_payments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "international_payments" ADD CONSTRAINT "international_payments_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "international_payments" ADD CONSTRAINT "international_payments_bank_fk" FOREIGN KEY ("bank_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "international_payments" ADD CONSTRAINT "international_payments_payment_fk" FOREIGN KEY ("payment_id", "org_id") REFERENCES "payments"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "international_payments" ADD CONSTRAINT "international_payments_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "international_payments" ADD CONSTRAINT "international_payments_approved_by_fk" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "international_payments" ADD CONSTRAINT "international_payments_sent_by_fk" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "international_payments" ADD CONSTRAINT "international_payments_paid_by_fk" FOREIGN KEY ("paid_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "international_payments" ADD CONSTRAINT "international_payments_cancelled_by_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "international_payments" ADD CONSTRAINT "international_payments_chk" CHECK (
  status IN ('DRAFT', 'APPROVED', 'SENT', 'PAID', 'CANCELLED')
  AND charges IN ('OUR', 'SHA', 'BEN')
  AND form15_part IN ('NONE', 'A', 'B', 'C', 'D')
  AND (NOT needs_15cb OR form15_part = 'C')
  AND amount >= 0
  AND (estimate_rate IS NULL OR estimate_rate > 0)
  AND (status IN ('DRAFT', 'CANCELLED') OR (approved_by_id IS NOT NULL AND approved_at IS NOT NULL AND amount > 0 AND purpose_code IS NOT NULL
       AND (form15_part = 'NONE' OR form15ca_ack IS NOT NULL) AND (NOT needs_15cb OR form15cb_number IS NOT NULL)))
  AND (NOT self_approved OR approved_by_id = created_by_id)
  AND (self_approved OR approved_by_id IS NULL OR approved_by_id <> created_by_id)
  AND (status NOT IN ('SENT', 'PAID') OR (sent_by_id IS NOT NULL AND sent_at IS NOT NULL))
  AND ((status = 'PAID') = (payment_id IS NOT NULL AND paid_rate IS NOT NULL AND paid_at IS NOT NULL))
  AND ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
  AND (status <> 'CANCELLED' OR length(btrim(coalesce(cancel_reason, ''))) > 0)
);

CREATE TABLE "international_payment_items" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "remittance_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    CONSTRAINT "international_payment_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "international_payment_items_chk" CHECK (amount > 0)
);
CREATE UNIQUE INDEX "international_payment_items_remittance_document_key" ON "international_payment_items"("remittance_id", "document_id");
CREATE INDEX "international_payment_items_org_id_idx" ON "international_payment_items"("org_id", "document_id");
ALTER TABLE "international_payment_items" ADD CONSTRAINT "international_payment_items_remittance_fk" FOREIGN KEY ("remittance_id", "org_id") REFERENCES "international_payments"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "international_payment_items" ADD CONSTRAINT "international_payment_items_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only a draft changes its content; once approved, only the steps forward (sent, paid) or a
-- cancellation; paid and cancelled are final. Items change only while the remittance is a draft.
CREATE FUNCTION t2t_guard_international_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only a draft international payment can be deleted; cancel it instead' USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('PAID', 'CANCELLED') THEN
    RAISE EXCEPTION 'This international payment is % and cannot change', lower(OLD.status) USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.contact_id, NEW.bank_account_id, NEW.payment_date, NEW.currency, NEW.amount, NEW.purpose_code, NEW.purpose, NEW.charges, NEW.taxable_in_india, NEW.has_tax_order, NEW.form15_part, NEW.needs_15cb, NEW.form15ca_ack, NEW.form15cb_number, NEW.approved_by_id)
     IS DISTINCT FROM (OLD.contact_id, OLD.bank_account_id, OLD.payment_date, OLD.currency, OLD.amount, OLD.purpose_code, OLD.purpose, OLD.charges, OLD.taxable_in_india, OLD.has_tax_order, OLD.form15_part, OLD.needs_15cb, OLD.form15ca_ack, OLD.form15cb_number, OLD.approved_by_id) THEN
    RAISE EXCEPTION 'An approved international payment cannot be changed; cancel it and prepare a new one' USING ERRCODE = 'P0001';
  END IF;
  IF NOT ((OLD.status = NEW.status) OR (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'CANCELLED')) OR (OLD.status = 'APPROVED' AND NEW.status IN ('SENT', 'CANCELLED')) OR (OLD.status = 'SENT' AND NEW.status IN ('PAID', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'An international payment cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER international_payments_guard BEFORE UPDATE OR DELETE ON "international_payments" FOR EACH ROW EXECUTE FUNCTION t2t_guard_international_payment();

CREATE FUNCTION t2t_guard_international_payment_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st TEXT;
BEGIN
  SELECT status INTO st FROM international_payments WHERE id = COALESCE(NEW.remittance_id, OLD.remittance_id);
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'The bills of an approved international payment cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER international_payment_items_guard BEFORE INSERT OR UPDATE OR DELETE ON "international_payment_items" FOR EACH ROW EXECUTE FUNCTION t2t_guard_international_payment_item();

ALTER TABLE "international_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "international_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "international_payments" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "international_payment_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "international_payment_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "international_payment_items" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
