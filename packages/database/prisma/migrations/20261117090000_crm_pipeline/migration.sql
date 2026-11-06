-- CRM slice 1: leads, deals (the sales pipeline) and their activity timeline.
CREATE TYPE "CrmLeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED');
CREATE TYPE "CrmLeadSource" AS ENUM ('WEBSITE', 'REFERRAL', 'EVENT', 'OUTBOUND', 'PARTNER', 'ADVERTISING', 'OTHER');
CREATE TYPE "CrmDealStage" AS ENUM ('PROSPECTING', 'QUALIFICATION', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST');
CREATE TYPE "CrmActivityKind" AS ENUM ('CREATED', 'NOTE', 'CALL', 'EMAIL', 'MEETING', 'STATUS_CHANGED', 'STAGE_CHANGED', 'CONVERTED', 'UPDATED');

CREATE TABLE "crm_leads" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "company" VARCHAR(200),
    "email" VARCHAR(254),
    "phone" VARCHAR(40),
    "source" "CrmLeadSource" NOT NULL DEFAULT 'OTHER',
    "status" "CrmLeadStatus" NOT NULL DEFAULT 'NEW',
    "owner_id" UUID,
    "estimated_value" DECIMAL(24,6),
    "notes" VARCHAR(2000),
    "disqualified_reason" VARCHAR(500),
    "converted_contact_id" UUID,
    "converted_deal_id" UUID,
    "converted_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "crm_leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_deals" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "contact_id" UUID NOT NULL,
    "lead_id" UUID,
    "amount" DECIMAL(24,6) NOT NULL,
    "stage" "CrmDealStage" NOT NULL DEFAULT 'PROSPECTING',
    "probability" INTEGER NOT NULL,
    "expected_close_date" DATE NOT NULL,
    "owner_id" UUID,
    "closed_on" DATE,
    "lost_reason" VARCHAR(500),
    "notes" VARCHAR(2000),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "crm_deals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_activities" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "lead_id" UUID,
    "deal_id" UUID,
    "kind" "CrmActivityKind" NOT NULL,
    "body" VARCHAR(4000),
    "data" JSONB,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_activities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crm_leads_org_id_number_key" ON "crm_leads"("org_id", "number");
CREATE UNIQUE INDEX "crm_leads_id_org_id_key" ON "crm_leads"("id", "org_id");
CREATE INDEX "crm_leads_org_id_status_idx" ON "crm_leads"("org_id", "status");
CREATE UNIQUE INDEX "crm_deals_org_id_number_key" ON "crm_deals"("org_id", "number");
CREATE UNIQUE INDEX "crm_deals_id_org_id_key" ON "crm_deals"("id", "org_id");
CREATE INDEX "crm_deals_org_id_stage_idx" ON "crm_deals"("org_id", "stage");
CREATE INDEX "crm_deals_org_id_contact_id_idx" ON "crm_deals"("org_id", "contact_id");
CREATE INDEX "crm_activities_org_id_lead_id_created_at_idx" ON "crm_activities"("org_id", "lead_id", "created_at");
CREATE INDEX "crm_activities_org_id_deal_id_created_at_idx" ON "crm_activities"("org_id", "deal_id", "created_at");
-- A lead converts into one deal at most, and a deal comes from one lead at most.
CREATE UNIQUE INDEX "crm_deals_lead_key" ON "crm_deals"("lead_id") WHERE "lead_id" IS NOT NULL;

ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_contact_fk" FOREIGN KEY ("converted_contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_lead_fk" FOREIGN KEY ("lead_id", "org_id") REFERENCES "crm_leads"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_deal_fk" FOREIGN KEY ("converted_deal_id", "org_id") REFERENCES "crm_deals"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_lead_fk" FOREIGN KEY ("lead_id", "org_id") REFERENCES "crm_leads"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_deal_fk" FOREIGN KEY ("deal_id", "org_id") REFERENCES "crm_deals"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_actor_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_chk" CHECK (
  number > 0 AND length(btrim(name)) > 0 AND (estimated_value IS NULL OR estimated_value >= 0)
  AND ((status = 'DISQUALIFIED') = (disqualified_reason IS NOT NULL))
  AND ((status = 'CONVERTED') = (converted_contact_id IS NOT NULL AND converted_at IS NOT NULL))
  AND (converted_deal_id IS NULL OR status = 'CONVERTED')
);
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_chk" CHECK (
  number > 0 AND length(btrim(name)) > 0 AND amount >= 0 AND probability BETWEEN 0 AND 100
  AND ((stage IN ('WON', 'LOST')) = (closed_on IS NOT NULL))
  AND (stage <> 'WON' OR probability = 100) AND (stage <> 'LOST' OR probability = 0)
  AND ((stage = 'LOST') = (lost_reason IS NOT NULL))
);
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_chk" CHECK ((lead_id IS NULL) <> (deal_id IS NULL));

-- Leads and deals are never deleted, keep their number and creator, and a converted lead does not change.
CREATE FUNCTION t2t_guard_crm_lead() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Leads are never deleted; disqualify them instead' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.number <> OLD.number OR NEW.created_by_id <> OLD.created_by_id THEN
    RAISE EXCEPTION 'A lead keeps its organisation, number and creator' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'CONVERTED' THEN
    RAISE EXCEPTION 'A converted lead does not change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_leads_guard BEFORE UPDATE OR DELETE ON "crm_leads" FOR EACH ROW EXECUTE FUNCTION t2t_guard_crm_lead();

CREATE FUNCTION t2t_guard_crm_deal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deals are never deleted; mark them lost instead' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.number <> OLD.number OR NEW.created_by_id <> OLD.created_by_id OR NEW.lead_id IS DISTINCT FROM OLD.lead_id THEN
    RAISE EXCEPTION 'A deal keeps its organisation, number, creator and lead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_deals_guard BEFORE UPDATE OR DELETE ON "crm_deals" FOR EACH ROW EXECUTE FUNCTION t2t_guard_crm_deal();

CREATE FUNCTION t2t_guard_crm_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The CRM activity timeline is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER crm_activities_guard BEFORE UPDATE OR DELETE ON "crm_activities" FOR EACH ROW EXECUTE FUNCTION t2t_guard_crm_activity();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_leads', 'crm_deals', 'crm_activities'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
