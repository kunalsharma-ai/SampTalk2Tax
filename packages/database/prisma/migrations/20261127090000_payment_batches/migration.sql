-- AP-014 payment batches and AP-027 vendor bank-detail change control.
CREATE TYPE "PaymentBatchStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED');

-- A vendor's bank account for payments (one per contact). Any change clears the verification.
CREATE TABLE "vendor_bank_details" (
    "contact_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "account_name" VARCHAR(140) NOT NULL,
    "account_number" VARCHAR(34) NOT NULL,
    "ifsc" CHAR(11) NOT NULL,
    "bank_name" VARCHAR(140),
    "changed_by_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by_id" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "verification_note" VARCHAR(500),
    CONSTRAINT "vendor_bank_details_pkey" PRIMARY KEY ("contact_id")
);
CREATE UNIQUE INDEX "vendor_bank_details_contact_id_org_id_key" ON "vendor_bank_details"("contact_id", "org_id");
CREATE INDEX "vendor_bank_details_org_id_idx" ON "vendor_bank_details"("org_id");
ALTER TABLE "vendor_bank_details" ADD CONSTRAINT "vendor_bank_details_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_bank_details" ADD CONSTRAINT "vendor_bank_details_changed_by_fk" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_bank_details" ADD CONSTRAINT "vendor_bank_details_verified_by_fk" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_bank_details" ADD CONSTRAINT "vendor_bank_details_chk" CHECK (
  ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$' AND account_number ~ '^[0-9A-Z]{6,34}$' AND length(trim(account_name)) > 0
  AND ((verified_by_id IS NULL) = (verified_at IS NULL))
);

-- Every change of a vendor's bank details, kept for good (account numbers masked).
CREATE TABLE "vendor_bank_detail_changes" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "before_masked" VARCHAR(80),
    "after_masked" VARCHAR(80) NOT NULL,
    "changed_by_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vendor_bank_detail_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vendor_bank_detail_changes_org_id_contact_id_idx" ON "vendor_bank_detail_changes"("org_id", "contact_id");
ALTER TABLE "vendor_bank_detail_changes" ADD CONSTRAINT "vendor_bank_detail_changes_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_bank_detail_changes" ADD CONSTRAINT "vendor_bank_detail_changes_changed_by_fk" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "payment_batches" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "payment_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "memo" VARCHAR(400),
    "status" "PaymentBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "file_downloaded_at" TIMESTAMPTZ(6),
    "paid_by_id" UUID,
    "paid_at" TIMESTAMPTZ(6),
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_batches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_batches_org_id_number_key" ON "payment_batches"("org_id", "number");
CREATE UNIQUE INDEX "payment_batches_id_org_id_key" ON "payment_batches"("id", "org_id");
CREATE INDEX "payment_batches_org_id_status_idx" ON "payment_batches"("org_id", "status");
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_bank_fk" FOREIGN KEY ("bank_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_approved_by_fk" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_paid_by_fk" FOREIGN KEY ("paid_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_cancelled_by_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_chk" CHECK (
  number > 0
  AND (status = 'CANCELLED' OR (status IN ('APPROVED', 'PAID')) = (approved_by_id IS NOT NULL AND approved_at IS NOT NULL))
  AND ((status = 'PAID') = (paid_by_id IS NOT NULL AND paid_at IS NOT NULL))
  AND ((status = 'CANCELLED') = (cancelled_by_id IS NOT NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
  AND (self_approved = false OR approved_by_id = created_by_id)
  AND (approved_by_id IS NULL OR approved_by_id <> created_by_id OR self_approved)
);

CREATE TABLE "payment_batch_items" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "payment_id" UUID,
    -- True while the batch is a draft or approved: a bill is in one open batch at a time.
    "open" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "payment_batch_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_batch_items_batch_id_document_id_key" ON "payment_batch_items"("batch_id", "document_id");
CREATE UNIQUE INDEX "payment_batch_items_open_document_key" ON "payment_batch_items"("document_id") WHERE "open";
CREATE INDEX "payment_batch_items_org_id_batch_id_idx" ON "payment_batch_items"("org_id", "batch_id");
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_batch_fk" FOREIGN KEY ("batch_id", "org_id") REFERENCES "payment_batches"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_payment_fk" FOREIGN KEY ("payment_id", "org_id") REFERENCES "payments"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_chk" CHECK (amount > 0);

-- Bank-detail changes are append-only; any edit of the details clears the verification.
CREATE FUNCTION t2t_guard_bank_detail_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Bank-detail change history is append-only' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER vendor_bank_detail_changes_guard BEFORE UPDATE OR DELETE ON "vendor_bank_detail_changes" FOR EACH ROW EXECUTE FUNCTION t2t_guard_bank_detail_change();

CREATE FUNCTION t2t_guard_vendor_bank_details() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Vendor bank details cannot be deleted; replace them instead' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.account_name, NEW.account_number, NEW.ifsc, NEW.bank_name) IS DISTINCT FROM (OLD.account_name, OLD.account_number, OLD.ifsc, OLD.bank_name) THEN
    -- New details are never verified by the same write.
    NEW.verified_by_id := NULL;
    NEW.verified_at := NULL;
    NEW.verification_note := NULL;
  ELSIF NEW.verified_by_id IS NOT NULL AND NEW.verified_by_id = NEW.changed_by_id AND current_setting('t2t.allow_self_verify', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Bank details must be verified by someone other than the person who changed them' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vendor_bank_details_guard BEFORE UPDATE OR DELETE ON "vendor_bank_details" FOR EACH ROW EXECUTE FUNCTION t2t_guard_vendor_bank_details();

-- A batch's items change only while it is a draft (except being linked to their payment when paid,
-- and closed when the batch is paid or cancelled); a paid or cancelled batch is final.
CREATE FUNCTION t2t_guard_payment_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only a draft payment batch can be deleted; cancel it instead' USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('PAID', 'CANCELLED') THEN
    RAISE EXCEPTION 'A paid or cancelled payment batch is final' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'APPROVED' AND (NEW.bank_account_id, NEW.payment_date, NEW.currency, NEW.created_by_id, NEW.approved_by_id, NEW.approved_at) IS DISTINCT FROM (OLD.bank_account_id, OLD.payment_date, OLD.currency, OLD.created_by_id, OLD.approved_by_id, OLD.approved_at) THEN
    RAISE EXCEPTION 'An approved payment batch cannot be changed; cancel it and prepare a new one' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_batches_guard BEFORE UPDATE OR DELETE ON "payment_batches" FOR EACH ROW EXECUTE FUNCTION t2t_guard_payment_batch();

CREATE FUNCTION t2t_guard_payment_batch_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "PaymentBatchStatus";
BEGIN
  SELECT status INTO s FROM payment_batches WHERE id = COALESCE(NEW.batch_id, OLD.batch_id);
  IF s IS NULL THEN RETURN COALESCE(NEW, OLD); END IF; -- the batch itself is being deleted
  IF TG_OP = 'UPDATE' AND (NEW.batch_id, NEW.document_id, NEW.contact_id, NEW.amount) IS NOT DISTINCT FROM (OLD.batch_id, OLD.document_id, OLD.contact_id, OLD.amount)
     AND (OLD.payment_id IS NULL OR NEW.payment_id = OLD.payment_id) THEN
    RETURN NEW; -- linking the payment, or closing the item
  END IF;
  IF s <> 'DRAFT' THEN
    RAISE EXCEPTION 'Payment batch items change only while the batch is a draft' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER payment_batch_items_guard BEFORE INSERT OR UPDATE OR DELETE ON "payment_batch_items" FOR EACH ROW EXECUTE FUNCTION t2t_guard_payment_batch_item();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_bank_details', 'vendor_bank_detail_changes', 'payment_batches', 'payment_batch_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
