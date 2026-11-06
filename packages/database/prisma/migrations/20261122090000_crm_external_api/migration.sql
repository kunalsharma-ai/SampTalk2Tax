-- CRM slice 6: connecting an external CRM. API keys let another system read and write leads,
-- deals and customers through /v1/crm-api; only a SHA-256 of each key is kept. Webhooks send
-- CRM events (from the audit trail) to another system, signed with a secret sealed by the API.
-- Leads and deals can carry the other system's id, so the same record is never created twice.

CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "prefix" VARCHAR(16) NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,
    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "api_keys_scopes_check" CHECK (cardinality("scopes") >= 1 AND "scopes" <@ ARRAY['crm.read', 'crm.write']::TEXT[]),
    CONSTRAINT "api_keys_revoked_check" CHECK (("revoked_at" IS NULL) = ("revoked_by_id" IS NULL))
);
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");
CREATE UNIQUE INDEX "api_keys_id_org_id_key" ON "api_keys"("id", "org_id");
CREATE INDEX "api_keys_org_id_idx" ON "api_keys"("org_id");
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A key's name, scopes and hash never change; it can only be used (last_used_at) or revoked, once.
CREATE FUNCTION t2t_guard_api_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An API key is revoked, never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.name <> OLD.name OR NEW.prefix <> OLD.prefix OR NEW.key_hash <> OLD.key_hash OR NEW.scopes <> OLD.scopes
     OR NEW.created_by_id <> OLD.created_by_id OR NEW.created_at <> OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by_id IS DISTINCT FROM OLD.revoked_by_id)) THEN
    RAISE EXCEPTION 'An API key only records its use or its revocation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER api_keys_guard BEFORE UPDATE OR DELETE ON "api_keys" FOR EACH ROW EXECUTE FUNCTION t2t_guard_api_key();

CREATE TABLE "crm_webhooks" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "events" TEXT[] NOT NULL,
    "secret_cipher" TEXT NOT NULL,
    "secret_key_id" VARCHAR(16) NOT NULL,
    "secret_hint" VARCHAR(16) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_event_id" BIGINT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_webhooks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_webhooks_events_check" CHECK (cardinality("events") >= 1)
);
CREATE UNIQUE INDEX "crm_webhooks_id_org_id_key" ON "crm_webhooks"("id", "org_id");
CREATE INDEX "crm_webhooks_org_id_idx" ON "crm_webhooks"("org_id");
ALTER TABLE "crm_webhooks" ADD CONSTRAINT "crm_webhooks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_webhooks" ADD CONSTRAINT "crm_webhooks_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "crm_webhook_deliveries" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "event_id" BIGINT,
    "event" VARCHAR(40) NOT NULL,
    "body" TEXT NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_status_code" INTEGER,
    "last_error" VARCHAR(300),
    "response_snippet" VARCHAR(500),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    CONSTRAINT "crm_webhook_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_webhook_deliveries_status_check" CHECK ("status" IN ('PENDING', 'SUCCEEDED', 'FAILED')),
    CONSTRAINT "crm_webhook_deliveries_pending_check" CHECK (("status" = 'PENDING') = ("next_attempt_at" IS NOT NULL) AND ("status" = 'PENDING') = ("finished_at" IS NULL))
);
-- One delivery per webhook and event; a test delivery has no event.
CREATE UNIQUE INDEX "crm_webhook_deliveries_webhook_id_event_id_key" ON "crm_webhook_deliveries"("webhook_id", "event_id");
CREATE INDEX "crm_webhook_deliveries_org_id_webhook_id_created_at_idx" ON "crm_webhook_deliveries"("org_id", "webhook_id", "created_at");
CREATE INDEX "crm_webhook_deliveries_due_idx" ON "crm_webhook_deliveries"("next_attempt_at") WHERE "status" = 'PENDING';
ALTER TABLE "crm_webhook_deliveries" ADD CONSTRAINT "crm_webhook_deliveries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_webhook_deliveries" ADD CONSTRAINT "crm_webhook_deliveries_webhook_fkey" FOREIGN KEY ("webhook_id", "org_id") REFERENCES "crm_webhooks"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The other system's id for a lead or deal made through the API, unique within the organisation.
ALTER TABLE "crm_leads" ADD COLUMN "external_ref" VARCHAR(100);
ALTER TABLE "crm_deals" ADD COLUMN "external_ref" VARCHAR(100);
CREATE UNIQUE INDEX "crm_leads_org_id_external_ref_key" ON "crm_leads"("org_id", "external_ref");
CREATE UNIQUE INDEX "crm_deals_org_id_external_ref_key" ON "crm_deals"("org_id", "external_ref");

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "api_keys" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "crm_webhooks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "crm_webhooks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "crm_webhooks" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "crm_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "crm_webhook_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "crm_webhook_deliveries" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
