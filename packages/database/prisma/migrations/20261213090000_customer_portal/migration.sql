-- AR-030 customer portal: a private link per customer to see their invoices, statement and
-- payment links without signing in. Only a hash of the link's secret is stored.

CREATE TABLE "customer_portal_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "prefix" VARCHAR(12) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "note" VARCHAR(200),
    "expires_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,
    CONSTRAINT "customer_portal_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_portal_links_token_hash_key" ON "customer_portal_links"("token_hash");
CREATE UNIQUE INDEX "customer_portal_links_id_org_id_key" ON "customer_portal_links"("id", "org_id");
CREATE INDEX "customer_portal_links_org_id_contact_id_idx" ON "customer_portal_links"("org_id", "contact_id");
ALTER TABLE "customer_portal_links" ADD CONSTRAINT "customer_portal_links_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_portal_links" ADD CONSTRAINT "customer_portal_links_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_portal_links" ADD CONSTRAINT "customer_portal_links_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_portal_links" ADD CONSTRAINT "customer_portal_links_revoked_by_fk" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_portal_links" ADD CONSTRAINT "customer_portal_links_chk" CHECK (
  token_hash ~ '^[0-9a-f]{64}$' AND view_count >= 0
  AND (expires_at IS NULL OR expires_at > created_at)
  AND ((revoked_at IS NULL) = (revoked_by_id IS NULL))
);

-- A link is never deleted. Only its use is counted and it can be revoked, once.
CREATE FUNCTION t2t_guard_customer_portal_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Customer portal links are never deleted; revoke them' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.contact_id <> OLD.contact_id OR NEW.prefix <> OLD.prefix OR NEW.token_hash <> OLD.token_hash
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_by_id <> OLD.created_by_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A customer portal link keeps its customer, secret and expiry' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by_id IS DISTINCT FROM OLD.revoked_by_id) THEN
    RAISE EXCEPTION 'A revoked customer portal link stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_portal_links_guard BEFORE UPDATE OR DELETE ON "customer_portal_links" FOR EACH ROW EXECUTE FUNCTION t2t_guard_customer_portal_link();

ALTER TABLE "customer_portal_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_portal_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_portal_links" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
