-- AR-003 customer onboarding: what an organisation collects about a new customer, and its approval,
-- before the customer is invoiced.
ALTER TYPE "AttachmentEntity" ADD VALUE 'CUSTOMER_ONBOARDING';

-- Whether customers added from now on must be onboarded before they are invoiced.
CREATE TABLE "customer_onboarding_settings" (
    "org_id" UUID NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_onboarding_settings_pkey" PRIMARY KEY ("org_id")
);
ALTER TABLE "customer_onboarding_settings" ADD CONSTRAINT "customer_onboarding_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_onboarding_settings" ADD CONSTRAINT "customer_onboarding_settings_updated_by_fk" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The organisation's own checklist: documents and checks every new customer goes through.
CREATE TABLE "customer_onboarding_requirements" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "label" VARCHAR(300) NOT NULL,
    "needs_file" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_onboarding_requirements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_onboarding_requirements_chk" CHECK (length(btrim(label)) > 0)
);
CREATE UNIQUE INDEX "customer_onboarding_requirements_id_org_id_key" ON "customer_onboarding_requirements"("id", "org_id");
CREATE INDEX "customer_onboarding_requirements_org_id_idx" ON "customer_onboarding_requirements"("org_id", "sort_order");
ALTER TABLE "customer_onboarding_requirements" ADD CONSTRAINT "customer_onboarding_requirements_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One onboarding per customer.
CREATE TABLE "customer_onboardings" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    "credit_limit" DECIMAL(24,6),
    "payment_terms_days" INTEGER,
    "notes" VARCHAR(2000),
    "submitted_by_id" UUID,
    "submitted_at" TIMESTAMPTZ(6),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" VARCHAR(1000),
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_onboardings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_onboardings_id_org_id_key" ON "customer_onboardings"("id", "org_id");
CREATE UNIQUE INDEX "customer_onboardings_org_id_contact_id_key" ON "customer_onboardings"("org_id", "contact_id");
CREATE INDEX "customer_onboardings_org_id_status_idx" ON "customer_onboardings"("org_id", "status");
ALTER TABLE "customer_onboardings" ADD CONSTRAINT "customer_onboardings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_onboardings" ADD CONSTRAINT "customer_onboardings_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_onboardings" ADD CONSTRAINT "customer_onboardings_submitted_by_fk" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_onboardings" ADD CONSTRAINT "customer_onboardings_decided_by_fk" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_onboardings" ADD CONSTRAINT "customer_onboardings_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_onboardings" ADD CONSTRAINT "customer_onboardings_chk" CHECK (
  status IN ('OPEN', 'SUBMITTED', 'APPROVED', 'REJECTED')
  AND (credit_limit IS NULL OR credit_limit >= 0)
  AND (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365)
  AND (status = 'OPEN' OR (submitted_by_id IS NOT NULL AND submitted_at IS NOT NULL))
  AND ((status IN ('APPROVED', 'REJECTED')) = (decided_by_id IS NOT NULL AND decided_at IS NOT NULL))
  AND (status <> 'APPROVED' OR (credit_limit IS NOT NULL AND payment_terms_days IS NOT NULL))
  AND (status <> 'REJECTED' OR length(btrim(coalesce(decision_note, ''))) > 0)
  AND (NOT self_approved OR (status = 'APPROVED' AND decided_by_id = submitted_by_id))
  AND (status <> 'APPROVED' OR self_approved OR decided_by_id <> submitted_by_id)
);

-- The organisation's checklist items as they stood when the onboarding started.
CREATE TABLE "customer_onboarding_checks" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "onboarding_id" UUID NOT NULL,
    "requirement_id" UUID,
    "label" VARCHAR(300) NOT NULL,
    "needs_file" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "done_by_id" UUID,
    "done_at" TIMESTAMPTZ(6),
    "note" VARCHAR(1000),
    "attachment_id" UUID,
    CONSTRAINT "customer_onboarding_checks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_onboarding_checks_chk" CHECK (done = (done_by_id IS NOT NULL AND done_at IS NOT NULL) AND (NOT done OR NOT needs_file OR attachment_id IS NOT NULL))
);
CREATE UNIQUE INDEX "customer_onboarding_checks_onboarding_requirement_key" ON "customer_onboarding_checks"("onboarding_id", "requirement_id");
CREATE INDEX "customer_onboarding_checks_org_id_onboarding_id_idx" ON "customer_onboarding_checks"("org_id", "onboarding_id");
ALTER TABLE "customer_onboarding_checks" ADD CONSTRAINT "customer_onboarding_checks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_onboarding_checks" ADD CONSTRAINT "customer_onboarding_checks_onboarding_fk" FOREIGN KEY ("onboarding_id", "org_id") REFERENCES "customer_onboardings"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_onboarding_checks" ADD CONSTRAINT "customer_onboarding_checks_requirement_fk" FOREIGN KEY ("requirement_id", "org_id") REFERENCES "customer_onboarding_requirements"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_onboarding_checks" ADD CONSTRAINT "customer_onboarding_checks_attachment_fk" FOREIGN KEY ("attachment_id", "org_id") REFERENCES "attachments"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_onboarding_checks" ADD CONSTRAINT "customer_onboarding_checks_done_by_fk" FOREIGN KEY ("done_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An approved onboarding is final; a submitted one waits for a decision; a rejected one can only be
-- reopened. Onboardings are never deleted and keep their customer.
CREATE FUNCTION t2t_check_customer_onboarding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A customer onboarding cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
    RAISE EXCEPTION 'A customer onboarding keeps its customer' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'This customer onboarding is approved and can no longer change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status NOT IN ('APPROVED', 'REJECTED', 'OPEN') THEN
    RAISE EXCEPTION 'A submitted customer onboarding is approved, rejected or taken back' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status = 'SUBMITTED' THEN
    RAISE EXCEPTION 'A submitted customer onboarding cannot change; take it back first' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'REJECTED' AND NEW.status <> 'OPEN' THEN
    RAISE EXCEPTION 'A rejected customer onboarding can only be reopened' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_onboardings_check BEFORE UPDATE OR DELETE ON "customer_onboardings" FOR EACH ROW EXECUTE FUNCTION t2t_check_customer_onboarding();

-- Checklist items change only while their onboarding is open, and only for a customer onboarding.
CREATE FUNCTION t2t_check_customer_onboarding_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st TEXT;
  att RECORD;
BEGIN
  SELECT status INTO st FROM customer_onboardings WHERE id = COALESCE(NEW.onboarding_id, OLD.onboarding_id);
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A customer onboarding check cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.onboarding_id IS DISTINCT FROM OLD.onboarding_id OR NEW.requirement_id IS DISTINCT FROM OLD.requirement_id OR NEW.label IS DISTINCT FROM OLD.label OR NEW.needs_file IS DISTINCT FROM OLD.needs_file) THEN
    RAISE EXCEPTION 'A customer onboarding check keeps what it asks for' USING ERRCODE = 'check_violation';
  END IF;
  IF st <> 'OPEN' THEN
    RAISE EXCEPTION 'This customer onboarding is not open; checks can change only while it is in progress' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attachment_id IS NOT NULL THEN
    SELECT entity_type::text AS entity_type, entity_id, removed_at INTO att FROM attachments WHERE id = NEW.attachment_id;
    IF att.entity_type <> 'CUSTOMER_ONBOARDING' OR att.entity_id <> NEW.onboarding_id OR att.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'A customer onboarding check needs a file attached to the same onboarding' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_onboarding_checks_check BEFORE INSERT OR UPDATE OR DELETE ON "customer_onboarding_checks" FOR EACH ROW EXECUTE FUNCTION t2t_check_customer_onboarding_check();

-- While onboarding is required, a new customer (or a contact that becomes a customer) starts one.
CREATE FUNCTION t2t_start_customer_onboarding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_customer AND (TG_OP = 'INSERT' OR NOT OLD.is_customer)
     AND EXISTS (SELECT 1 FROM customer_onboarding_settings s WHERE s.org_id = NEW.org_id AND s.required) THEN
    INSERT INTO customer_onboardings (id, org_id, contact_id, status, created_at, updated_at)
    VALUES (gen_random_uuid(), NEW.org_id, NEW.id, 'OPEN', now(), now())
    ON CONFLICT (org_id, contact_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contacts_start_customer_onboarding AFTER INSERT OR UPDATE OF is_customer ON "contacts" FOR EACH ROW EXECUTE FUNCTION t2t_start_customer_onboarding();

ALTER TABLE "customer_onboarding_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_onboarding_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_onboarding_settings" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "customer_onboarding_requirements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_onboarding_requirements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_onboarding_requirements" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "customer_onboardings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_onboardings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_onboardings" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "customer_onboarding_checks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_onboarding_checks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_onboarding_checks" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
