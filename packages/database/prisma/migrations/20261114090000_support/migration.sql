-- Support (M9 slice 4): tickets between an organisation and the people who run Talk2Tax, and
-- time-limited, read-only support access to an organisation's books that only the
-- organisation can grant. Every look at the books under a grant is logged.

CREATE TABLE "support_tickets" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "number" SERIAL NOT NULL,
  "subject" VARCHAR(200) NOT NULL,
  "category" VARCHAR(12) NOT NULL,
  "priority" VARCHAR(8) NOT NULL,
  "status" VARCHAR(8) NOT NULL DEFAULT 'OPEN',
  "created_by" UUID NOT NULL,
  "assignee_id" UUID,
  "first_response_at" TIMESTAMPTZ(6),
  "resolved_at" TIMESTAMPTZ(6),
  "closed_at" TIMESTAMPTZ(6),
  "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_tickets_category_check" CHECK ("category" IN ('BILLING', 'TECHNICAL', 'ACCOUNTING', 'TAX', 'ACCOUNT', 'OTHER')),
  CONSTRAINT "support_tickets_priority_check" CHECK ("priority" IN ('URGENT', 'HIGH', 'NORMAL', 'LOW')),
  CONSTRAINT "support_tickets_status_check" CHECK ("status" IN ('OPEN', 'PENDING', 'RESOLVED', 'CLOSED')),
  CONSTRAINT "support_tickets_subject_check" CHECK (length(btrim("subject")) BETWEEN 3 AND 200),
  CONSTRAINT "support_tickets_closed_check" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "support_tickets_number_key" ON "support_tickets"("number");
CREATE INDEX "support_tickets_org_id_created_at_idx" ON "support_tickets"("org_id", "created_at");
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");
CREATE UNIQUE INDEX "support_tickets_id_org_id_key" ON "support_tickets"("id", "org_id");
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The conversation. Messages are never edited or deleted. Internal notes are support's own and
-- the API never shows them to the organisation.
CREATE TABLE "support_messages" (
  "id" UUID NOT NULL,
  "ticket_id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "author_id" UUID NOT NULL,
  "side" VARCHAR(8) NOT NULL,
  "internal" BOOLEAN NOT NULL DEFAULT false,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_messages_side_check" CHECK ("side" IN ('CUSTOMER', 'SUPPORT')),
  CONSTRAINT "support_messages_internal_check" CHECK (NOT "internal" OR "side" = 'SUPPORT'),
  CONSTRAINT "support_messages_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 10000)
);
CREATE INDEX "support_messages_ticket_id_created_at_idx" ON "support_messages"("ticket_id", "created_at");
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id", "org_id") REFERENCES "support_tickets"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Read-only access to the books for the people who run Talk2Tax, granted by the organisation.
CREATE TABLE "support_access_grants" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "ticket_id" UUID,
  "reason" VARCHAR(500) NOT NULL,
  "granted_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "revoked_by" UUID,
  CONSTRAINT "support_access_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_access_grants_window_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '72 hours'),
  CONSTRAINT "support_access_grants_revoked_check" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL)),
  CONSTRAINT "support_access_grants_reason_check" CHECK (length(btrim("reason")) >= 3)
);
CREATE INDEX "support_access_grants_org_id_expires_at_idx" ON "support_access_grants"("org_id", "expires_at");
CREATE UNIQUE INDEX "support_access_grants_id_org_id_key" ON "support_access_grants"("id", "org_id");
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_ticket_id_fkey" FOREIGN KEY ("ticket_id", "org_id") REFERENCES "support_tickets"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every request support made under a grant: who, when, what.
CREATE TABLE "support_access_views" (
  "id" BIGSERIAL NOT NULL,
  "grant_id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "path" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_access_views_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_access_views_org_id_created_at_idx" ON "support_access_views"("org_id", "created_at");
ALTER TABLE "support_access_views" ADD CONSTRAINT "support_access_views_grant_id_fkey" FOREIGN KEY ("grant_id", "org_id") REFERENCES "support_access_grants"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_access_views" ADD CONSTRAINT "support_access_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Messages and the access log are append-only; a grant can only be revoked, once.
CREATE OR REPLACE FUNCTION t2t_support_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be changed or deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER support_messages_append_only BEFORE UPDATE OR DELETE ON "support_messages" FOR EACH ROW EXECUTE FUNCTION t2t_support_append_only();
CREATE TRIGGER support_access_views_append_only BEFORE UPDATE OR DELETE ON "support_access_views" FOR EACH ROW EXECUTE FUNCTION t2t_support_append_only();

CREATE OR REPLACE FUNCTION t2t_support_grant_final() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support access grants cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."revoked_at" IS NOT NULL
     OR NEW."org_id" IS DISTINCT FROM OLD."org_id" OR NEW."ticket_id" IS DISTINCT FROM OLD."ticket_id"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."granted_by" IS DISTINCT FROM OLD."granted_by"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'a support access grant can only be revoked, once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER support_access_grants_final BEFORE UPDATE OR DELETE ON "support_access_grants" FOR EACH ROW EXECUTE FUNCTION t2t_support_grant_final();

ALTER TABLE "support_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "support_tickets"
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "support_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "support_messages"
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "support_access_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_access_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "support_access_grants"
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "support_access_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_access_views" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "support_access_views"
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
