-- AP-013 vendor portal: a private link per vendor to see their bills, payments, purchase orders and
-- statement, and to send invoices for the business to record. Only a hash of the link's secret is stored.

CREATE TABLE "vendor_portal_links" (
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
    CONSTRAINT "vendor_portal_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vendor_portal_links_token_hash_key" ON "vendor_portal_links"("token_hash");
CREATE UNIQUE INDEX "vendor_portal_links_id_org_id_key" ON "vendor_portal_links"("id", "org_id");
CREATE INDEX "vendor_portal_links_org_id_contact_id_idx" ON "vendor_portal_links"("org_id", "contact_id");
ALTER TABLE "vendor_portal_links" ADD CONSTRAINT "vendor_portal_links_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_portal_links" ADD CONSTRAINT "vendor_portal_links_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_portal_links" ADD CONSTRAINT "vendor_portal_links_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_portal_links" ADD CONSTRAINT "vendor_portal_links_revoked_by_fk" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_portal_links" ADD CONSTRAINT "vendor_portal_links_chk" CHECK (
  token_hash ~ '^[0-9a-f]{64}$' AND view_count >= 0
  AND (expires_at IS NULL OR expires_at > created_at)
  AND ((revoked_at IS NULL) = (revoked_by_id IS NULL))
);

-- A link is never deleted. Only its use is counted and it can be revoked, once.
CREATE FUNCTION t2t_guard_vendor_portal_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Vendor portal links are never deleted; revoke them' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.contact_id <> OLD.contact_id OR NEW.prefix <> OLD.prefix OR NEW.token_hash <> OLD.token_hash
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_by_id <> OLD.created_by_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A vendor portal link keeps its vendor, secret and expiry' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by_id IS DISTINCT FROM OLD.revoked_by_id) THEN
    RAISE EXCEPTION 'A revoked vendor portal link stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vendor_portal_links_guard BEFORE UPDATE OR DELETE ON "vendor_portal_links" FOR EACH ROW EXECUTE FUNCTION t2t_guard_vendor_portal_link();

ALTER TABLE "vendor_portal_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendor_portal_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vendor_portal_links" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());

-- Invoices a vendor sends through the portal. They wait for staff to record them as a bill or
-- turn them down with a reason. Never deleted; what the vendor sent stays as sent.
CREATE TABLE "vendor_portal_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "invoice_number" VARCHAR(40) NOT NULL,
    "number_key" VARCHAR(40) NOT NULL,
    "invoice_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "purchase_order_id" UUID,
    "note" VARCHAR(500),
    "file_name" VARCHAR(200),
    "content_type" VARCHAR(40),
    "size_bytes" INTEGER,
    "sha256" CHAR(64),
    "content" BYTEA,
    "status" VARCHAR(8) NOT NULL DEFAULT 'RECEIVED',
    "document_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "reject_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vendor_portal_submissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vendor_portal_submissions_id_org_id_key" ON "vendor_portal_submissions"("id", "org_id");
CREATE INDEX "vendor_portal_submissions_org_id_status_idx" ON "vendor_portal_submissions"("org_id", "status", "created_at");
CREATE INDEX "vendor_portal_submissions_org_id_contact_id_idx" ON "vendor_portal_submissions"("org_id", "contact_id");
-- The same invoice cannot wait twice, or be recorded twice.
CREATE UNIQUE INDEX "vendor_portal_submissions_live_number_key" ON "vendor_portal_submissions"("org_id", "contact_id", "number_key") WHERE status <> 'REJECTED';
-- A bill records at most one sent invoice.
CREATE UNIQUE INDEX "vendor_portal_submissions_document_key" ON "vendor_portal_submissions"("org_id", "document_id") WHERE document_id IS NOT NULL;
ALTER TABLE "vendor_portal_submissions" ADD CONSTRAINT "vendor_portal_submissions_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_portal_submissions" ADD CONSTRAINT "vendor_portal_submissions_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_portal_submissions" ADD CONSTRAINT "vendor_portal_submissions_link_fk" FOREIGN KEY ("link_id", "org_id") REFERENCES "vendor_portal_links"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_portal_submissions" ADD CONSTRAINT "vendor_portal_submissions_order_fk" FOREIGN KEY ("purchase_order_id", "org_id") REFERENCES "purchase_orders"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_portal_submissions" ADD CONSTRAINT "vendor_portal_submissions_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_portal_submissions" ADD CONSTRAINT "vendor_portal_submissions_decided_by_fk" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_portal_submissions" ADD CONSTRAINT "vendor_portal_submissions_chk" CHECK (
  status IN ('RECEIVED', 'RECORDED', 'REJECTED')
  AND amount > 0 AND currency ~ '^[A-Z]{3}$' AND length(number_key) > 0
  AND ((content IS NULL) = (sha256 IS NULL) AND (content IS NULL) = (file_name IS NULL) AND (content IS NULL) = (content_type IS NULL) AND (content IS NULL) = (size_bytes IS NULL))
  AND (size_bytes IS NULL OR (size_bytes > 0 AND size_bytes <= 5242880))
  AND (status = 'RECEIVED') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by_id IS NULL)
  AND (status = 'RECORDED') = (document_id IS NOT NULL)
  AND (status = 'REJECTED') = (reject_reason IS NOT NULL)
);

CREATE FUNCTION t2t_guard_vendor_portal_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Invoices sent through the vendor portal are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.contact_id <> OLD.contact_id OR NEW.link_id <> OLD.link_id OR NEW.invoice_number <> OLD.invoice_number
     OR NEW.number_key <> OLD.number_key OR NEW.invoice_date <> OLD.invoice_date OR NEW.currency <> OLD.currency OR NEW.amount <> OLD.amount
     OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id OR NEW.note IS DISTINCT FROM OLD.note OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An invoice sent through the vendor portal stays as it was sent' USING ERRCODE = 'check_violation';
  END IF;
  -- The file can be added once, while the invoice is still waiting.
  IF OLD.content IS NOT NULL AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.file_name IS DISTINCT FROM OLD.file_name) THEN
    RAISE EXCEPTION 'The file of a sent invoice cannot be replaced' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.content IS NULL AND NEW.content IS NOT NULL AND OLD.status <> 'RECEIVED' THEN
    RAISE EXCEPTION 'A file can be added only while the invoice is waiting' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'RECEIVED' AND (NEW.status <> OLD.status OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
     OR NEW.decided_by_id IS DISTINCT FROM OLD.decided_by_id OR NEW.reject_reason IS DISTINCT FROM OLD.reject_reason) THEN
    RAISE EXCEPTION 'A sent invoice is decided once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vendor_portal_submissions_guard BEFORE UPDATE OR DELETE ON "vendor_portal_submissions" FOR EACH ROW EXECUTE FUNCTION t2t_guard_vendor_portal_submission();

ALTER TABLE "vendor_portal_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendor_portal_submissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vendor_portal_submissions" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
