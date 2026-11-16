-- AR-042 unbilled revenue detection: a person dismissing a finding (with the reason and the amount
-- it was dismissed at) or bringing it back. Kept as a history; the latest row decides.

CREATE TABLE "unbilled_revenue_dismissals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "fingerprint" VARCHAR(80) NOT NULL,
    "action" VARCHAR(7) NOT NULL,
    "amount" DECIMAL(24,6),
    "currency" CHAR(3) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "unbilled_revenue_dismissals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "unbilled_revenue_dismissals_org_id_fingerprint_idx" ON "unbilled_revenue_dismissals"("org_id", "fingerprint", "created_at");
ALTER TABLE "unbilled_revenue_dismissals" ADD CONSTRAINT "unbilled_revenue_dismissals_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unbilled_revenue_dismissals" ADD CONSTRAINT "unbilled_revenue_dismissals_user_fk" FOREIGN KEY ("by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unbilled_revenue_dismissals" ADD CONSTRAINT "unbilled_revenue_dismissals_chk" CHECK (
  action IN ('DISMISS', 'RESTORE')
  AND fingerprint ~ '^(MILESTONE|CONTRACT_PERIOD|DRAFT_INVOICE|ORDER|PRO_FORMA|REGULAR_CUSTOMER):[0-9a-f-]{36}$'
  AND length(btrim(reason)) >= 3
  AND (amount IS NULL OR amount >= 0)
);

CREATE FUNCTION t2t_guard_unbilled_dismissal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Unbilled revenue dismissals are kept as recorded; bring the finding back instead' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER unbilled_revenue_dismissals_guard BEFORE UPDATE OR DELETE ON "unbilled_revenue_dismissals" FOR EACH ROW EXECUTE FUNCTION t2t_guard_unbilled_dismissal();

ALTER TABLE "unbilled_revenue_dismissals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unbilled_revenue_dismissals" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "unbilled_revenue_dismissals" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
