-- AP-002 vendor onboarding: the customer onboarding of AR-003 for vendors too. Each onboarding,
-- checklist and setting is for one party: CUSTOMER or VENDOR. A contact that is both has one of each.
ALTER TABLE "customer_onboarding_settings" ADD COLUMN "party" VARCHAR(8) NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE "customer_onboarding_settings" DROP CONSTRAINT "customer_onboarding_settings_pkey";
ALTER TABLE "customer_onboarding_settings" ADD CONSTRAINT "customer_onboarding_settings_pkey" PRIMARY KEY ("org_id", "party");
ALTER TABLE "customer_onboarding_settings" ADD CONSTRAINT "customer_onboarding_settings_party_chk" CHECK (party IN ('CUSTOMER', 'VENDOR'));

ALTER TABLE "customer_onboarding_requirements" ADD COLUMN "party" VARCHAR(8) NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE "customer_onboarding_requirements" ADD CONSTRAINT "customer_onboarding_requirements_party_chk" CHECK (party IN ('CUSTOMER', 'VENDOR'));
DROP INDEX "customer_onboarding_requirements_org_id_idx";
CREATE INDEX "customer_onboarding_requirements_org_id_idx" ON "customer_onboarding_requirements"("org_id", "party", "sort_order");

ALTER TABLE "customer_onboardings" ADD COLUMN "party" VARCHAR(8) NOT NULL DEFAULT 'CUSTOMER';
DROP INDEX "customer_onboardings_org_id_contact_id_key";
CREATE UNIQUE INDEX "customer_onboardings_org_id_contact_id_party_key" ON "customer_onboardings"("org_id", "contact_id", "party");
-- A vendor onboarding agrees payment terms only; a customer one also a credit limit.
ALTER TABLE "customer_onboardings" DROP CONSTRAINT "customer_onboardings_chk";
ALTER TABLE "customer_onboardings" ADD CONSTRAINT "customer_onboardings_chk" CHECK (
  status IN ('OPEN', 'SUBMITTED', 'APPROVED', 'REJECTED')
  AND party IN ('CUSTOMER', 'VENDOR')
  AND (credit_limit IS NULL OR credit_limit >= 0)
  AND (party = 'CUSTOMER' OR credit_limit IS NULL)
  AND (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365)
  AND (status = 'OPEN' OR (submitted_by_id IS NOT NULL AND submitted_at IS NOT NULL))
  AND ((status IN ('APPROVED', 'REJECTED')) = (decided_by_id IS NOT NULL AND decided_at IS NOT NULL))
  AND (status <> 'APPROVED' OR ((party = 'VENDOR' OR credit_limit IS NOT NULL) AND payment_terms_days IS NOT NULL))
  AND (status <> 'REJECTED' OR length(btrim(coalesce(decision_note, ''))) > 0)
  AND (NOT self_approved OR (status = 'APPROVED' AND decided_by_id = submitted_by_id))
  AND (status <> 'APPROVED' OR self_approved OR decided_by_id <> submitted_by_id)
);

-- An onboarding also keeps its party.
CREATE OR REPLACE FUNCTION t2t_check_customer_onboarding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A customer onboarding cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.party IS DISTINCT FROM OLD.party THEN
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

-- New customers and new vendors each start their own onboarding while their party requires it.
CREATE OR REPLACE FUNCTION t2t_start_customer_onboarding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_customer AND (TG_OP = 'INSERT' OR NOT OLD.is_customer)
     AND EXISTS (SELECT 1 FROM customer_onboarding_settings s WHERE s.org_id = NEW.org_id AND s.party = 'CUSTOMER' AND s.required) THEN
    INSERT INTO customer_onboardings (id, org_id, contact_id, party, status, created_at, updated_at)
    VALUES (gen_random_uuid(), NEW.org_id, NEW.id, 'CUSTOMER', 'OPEN', now(), now())
    ON CONFLICT (org_id, contact_id, party) DO NOTHING;
  END IF;
  IF NEW.is_vendor AND (TG_OP = 'INSERT' OR NOT OLD.is_vendor)
     AND EXISTS (SELECT 1 FROM customer_onboarding_settings s WHERE s.org_id = NEW.org_id AND s.party = 'VENDOR' AND s.required) THEN
    INSERT INTO customer_onboardings (id, org_id, contact_id, party, status, created_at, updated_at)
    VALUES (gen_random_uuid(), NEW.org_id, NEW.id, 'VENDOR', 'OPEN', now(), now())
    ON CONFLICT (org_id, contact_id, party) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER contacts_start_customer_onboarding ON "contacts";
CREATE TRIGGER contacts_start_customer_onboarding AFTER INSERT OR UPDATE OF is_customer, is_vendor ON "contacts" FOR EACH ROW EXECUTE FUNCTION t2t_start_customer_onboarding();
