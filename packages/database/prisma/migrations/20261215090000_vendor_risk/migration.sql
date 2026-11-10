-- AP-024 vendor risk monitoring: a person's review of a vendor's risk, kept as a history; and
-- the VENDOR_RISK alert check, raised while a medium or high risk waits for a review.

CREATE TABLE "vendor_risk_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "level" VARCHAR(6) NOT NULL,
    "factor_codes" TEXT[] NOT NULL DEFAULT '{}',
    "decision" VARCHAR(8) NOT NULL,
    "note" VARCHAR(1000) NOT NULL,
    "reviewed_on" DATE NOT NULL,
    "next_review_on" DATE NOT NULL,
    "reviewed_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vendor_risk_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vendor_risk_reviews_org_id_contact_id_idx" ON "vendor_risk_reviews"("org_id", "contact_id", "reviewed_on");
ALTER TABLE "vendor_risk_reviews" ADD CONSTRAINT "vendor_risk_reviews_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_risk_reviews" ADD CONSTRAINT "vendor_risk_reviews_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_risk_reviews" ADD CONSTRAINT "vendor_risk_reviews_user_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_risk_reviews" ADD CONSTRAINT "vendor_risk_reviews_chk" CHECK (
  level IN ('NONE', 'LOW', 'MEDIUM', 'HIGH')
  AND decision IN ('ACCEPTED', 'MONITOR', 'STOP')
  AND length(btrim(note)) >= 5
  AND next_review_on > reviewed_on
  AND next_review_on <= reviewed_on + 365
);

CREATE FUNCTION t2t_guard_vendor_risk_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Vendor risk reviews are kept as recorded; record a new review instead' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER vendor_risk_reviews_guard BEFORE UPDATE OR DELETE ON "vendor_risk_reviews" FOR EACH ROW EXECUTE FUNCTION t2t_guard_vendor_risk_review();

ALTER TABLE "vendor_risk_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendor_risk_reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vendor_risk_reviews" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());

-- The new alert check.
ALTER TABLE "alert_rule_settings" DROP CONSTRAINT "alert_rule_settings_chk";
ALTER TABLE "alert_rule_settings" ADD CONSTRAINT "alert_rule_settings_chk" CHECK (
  "rule" IN ('CASH_BELOW_MINIMUM', 'OVERDUE_RECEIVABLES', 'COMPLIANCE_DUE', 'KPI_TARGET_MISSED', 'BUDGET_OVERRUN', 'MISSED_RECURRING_BILLING', 'DUPLICATE_BILL', 'DUPLICATE_PAYMENT', 'UNUSUAL_JOURNAL', 'VENDOR_RISK')
  AND jsonb_typeof("params") = 'object');
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_chk";
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_chk" CHECK (
  "rule" IN ('CASH_BELOW_MINIMUM', 'OVERDUE_RECEIVABLES', 'COMPLIANCE_DUE', 'KPI_TARGET_MISSED', 'BUDGET_OVERRUN', 'MISSED_RECURRING_BILLING', 'DUPLICATE_BILL', 'DUPLICATE_PAYMENT', 'UNUSUAL_JOURNAL', 'VENDOR_RISK')
  AND length("fingerprint") > 0 AND length("title") > 0
  AND jsonb_typeof("evidence") = 'object'
  AND "last_seen_at" >= "first_seen_at" AND "reopen_count" >= 0
  -- Dismissing needs a person and a reason; acknowledging needs a person.
  AND ("status" <> 'DISMISSED' OR ("status_by_id" IS NOT NULL AND "status_note" IS NOT NULL AND length(btrim("status_note")) > 0))
  AND ("status" <> 'ACKNOWLEDGED' OR "status_by_id" IS NOT NULL)
  AND (("status" = 'CLEARED') = ("cleared_at" IS NOT NULL)));
