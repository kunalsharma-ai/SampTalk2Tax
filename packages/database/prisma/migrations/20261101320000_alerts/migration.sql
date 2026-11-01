-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('CRITICAL', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'CLEARED');

-- CreateEnum
CREATE TYPE "AlertAction" AS ENUM ('OPENED', 'ACKNOWLEDGED', 'DISMISSED', 'REOPENED', 'CLEARED');

-- CreateTable
CREATE TABLE "alert_rule_settings" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "rule" VARCHAR(40) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "params" JSONB NOT NULL DEFAULT '{}',
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alert_rule_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "rule" VARCHAR(40) NOT NULL,
    "fingerprint" VARCHAR(200) NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "summary" VARCHAR(2000) NOT NULL,
    "amount" DECIMAL(24,6),
    "evidence" JSONB NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "status_note" VARCHAR(1000),
    "status_by_id" UUID,
    "status_at" TIMESTAMPTZ(6),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleared_at" TIMESTAMPTZ(6),
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "action" "AlertAction" NOT NULL,
    "actor_id" UUID,
    "note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_scans" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "ran_by_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6) NOT NULL,
    "rules_run" INTEGER NOT NULL,
    "found" INTEGER NOT NULL,
    "opened" INTEGER NOT NULL,
    "reopened" INTEGER NOT NULL,
    "cleared" INTEGER NOT NULL,
    "failures" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "alert_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alert_rule_settings_org_id_rule_key" ON "alert_rule_settings"("org_id", "rule");

-- CreateIndex
CREATE INDEX "alerts_org_id_status_idx" ON "alerts"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_org_id_rule_fingerprint_key" ON "alerts"("org_id", "rule", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_id_org_id_key" ON "alerts"("id", "org_id");

-- CreateIndex
CREATE INDEX "alert_events_org_id_alert_id_idx" ON "alert_events"("org_id", "alert_id");

-- CreateIndex
CREATE INDEX "alert_scans_org_id_finished_at_idx" ON "alert_scans"("org_id", "finished_at");

-- AddForeignKey
ALTER TABLE "alert_rule_settings" ADD CONSTRAINT "alert_rule_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_alert_id_org_id_fkey" FOREIGN KEY ("alert_id", "org_id") REFERENCES "alerts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_scans" ADD CONSTRAINT "alert_scans_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------- hand-written

ALTER TABLE "alert_rule_settings" ADD CONSTRAINT "alert_rule_settings_chk" CHECK (
  "rule" IN ('CASH_BELOW_MINIMUM', 'OVERDUE_RECEIVABLES', 'COMPLIANCE_DUE', 'KPI_TARGET_MISSED', 'BUDGET_OVERRUN', 'MISSED_RECURRING_BILLING', 'DUPLICATE_BILL', 'DUPLICATE_PAYMENT', 'UNUSUAL_JOURNAL')
  AND jsonb_typeof("params") = 'object');

ALTER TABLE "alerts" ADD CONSTRAINT "alerts_chk" CHECK (
  "rule" IN ('CASH_BELOW_MINIMUM', 'OVERDUE_RECEIVABLES', 'COMPLIANCE_DUE', 'KPI_TARGET_MISSED', 'BUDGET_OVERRUN', 'MISSED_RECURRING_BILLING', 'DUPLICATE_BILL', 'DUPLICATE_PAYMENT', 'UNUSUAL_JOURNAL')
  AND length("fingerprint") > 0 AND length("title") > 0
  AND jsonb_typeof("evidence") = 'object'
  AND "last_seen_at" >= "first_seen_at" AND "reopen_count" >= 0
  -- Dismissing needs a person and a reason; acknowledging needs a person.
  AND ("status" <> 'DISMISSED' OR ("status_by_id" IS NOT NULL AND "status_note" IS NOT NULL AND length(btrim("status_note")) > 0))
  AND ("status" <> 'ACKNOWLEDGED' OR "status_by_id" IS NOT NULL)
  AND (("status" = 'CLEARED') = ("cleared_at" IS NOT NULL)));

ALTER TABLE "alert_scans" ADD CONSTRAINT "alert_scans_chk" CHECK (
  "finished_at" >= "started_at" AND "rules_run" >= 0 AND "found" >= 0 AND "opened" >= 0 AND "reopened" >= 0 AND "cleared" >= 0
  AND jsonb_typeof("failures") = 'array');

-- An alert keeps what it is about; it is never deleted, so its history stays whole.
CREATE OR REPLACE FUNCTION t2t_guard_alert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' THEN RAISE EXCEPTION 'An alert starts open' USING ERRCODE = 'P0001'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An alert cannot be deleted' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.rule <> OLD.rule OR NEW.fingerprint <> OLD.fingerprint OR NEW.first_seen_at <> OLD.first_seen_at THEN
    RAISE EXCEPTION 'An alert keeps its organisation, check and finding' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.reopen_count < OLD.reopen_count THEN RAISE EXCEPTION 'An alert''s reopen count only goes up' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alerts_guard BEFORE INSERT OR UPDATE OR DELETE ON "alerts" FOR EACH ROW EXECUTE FUNCTION t2t_guard_alert();

-- Alert history and runs of the checks are append-only.
CREATE OR REPLACE FUNCTION t2t_alert_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Alert history is append-only' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER alert_events_append_only BEFORE UPDATE OR DELETE ON "alert_events" FOR EACH ROW EXECUTE FUNCTION t2t_alert_append_only();
CREATE TRIGGER alert_scans_append_only BEFORE UPDATE OR DELETE ON "alert_scans" FOR EACH ROW EXECUTE FUNCTION t2t_alert_append_only();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['alert_rule_settings', 'alerts', 'alert_events', 'alert_scans'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
