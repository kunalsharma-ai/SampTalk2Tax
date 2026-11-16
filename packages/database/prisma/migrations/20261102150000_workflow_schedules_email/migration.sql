-- M5 slice 2: schedule triggers (a time, or a date reached by an invoice or bill) and email actions.

ALTER TABLE "workflow_runs" ADD COLUMN "occurrence_key" VARCHAR(100);
ALTER TABLE "workflow_versions" ADD COLUMN "trigger_params" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "workflows" ADD COLUMN "activated_at" TIMESTAMPTZ(6);

-- Workflows already on count as turned on when they were last changed. Row-level security
-- is forced on this table, so the update runs with the bypass setting for this transaction.
SELECT set_config('t2t.bypass', 'on', true);
UPDATE "workflows" SET "activated_at" = "updated_at" WHERE "enabled";

ALTER TABLE "workflows" DROP CONSTRAINT "workflows_chk";
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_chk" CHECK (
  length(btrim("name")) > 0 AND "current_version" >= 1 AND length("signing_secret") >= 32
  AND ("enabled" = false OR ("active_from_event_id" IS NOT NULL AND "activated_at" IS NOT NULL)) AND "updated_at" >= "created_at");

ALTER TABLE "workflow_versions" DROP CONSTRAINT "workflow_versions_chk";
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_chk" CHECK (
  "version" >= 1
  AND "trigger" IN ('INVOICE_POSTED', 'BILL_POSTED', 'DOCUMENT_VOIDED', 'RECEIPT_RECORDED', 'VENDOR_PAYMENT_RECORDED', 'JOURNAL_POSTED', 'EXPENSE_CLAIM_SUBMITTED', 'ALERT_OPENED',
                    'SCHEDULE', 'INVOICE_OVERDUE', 'BILL_DUE_SOON')
  AND jsonb_typeof("trigger_params") = 'object'
  AND ("trigger" IN ('SCHEDULE', 'INVOICE_OVERDUE', 'BILL_DUE_SOON') OR "trigger_params" = '{}'::jsonb)
  AND ("trigger" <> 'SCHEDULE' OR "trigger_params" ? 'frequency')
  AND ("trigger" NOT IN ('INVOICE_OVERDUE', 'BILL_DUE_SOON') OR jsonb_typeof("trigger_params" -> 'days') = 'number')
  AND jsonb_typeof("conditions") = 'array' AND jsonb_array_length("conditions") <= 10
  AND jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") BETWEEN 1 AND 5);

-- A live run comes from an audit event (event triggers) or an occurrence (schedule triggers), never both.
ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_chk";
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_chk" CHECK (
  "version" >= 1 AND jsonb_typeof("facts") = 'object' AND jsonb_typeof("conditions") = 'array'
  AND (("status" = 'TEST') = ("tested_by_id" IS NOT NULL))
  AND ("status" = 'TEST' OR (("event_id" IS NULL) <> ("occurrence_key" IS NULL)))
  AND ("occurrence_key" IS NULL OR length("occurrence_key") > 0)
  AND (("status" = 'RUNNING') = ("finished_at" IS NULL))
  AND ("status" <> 'FAILED' OR "error" IS NOT NULL));
-- A schedule acts once per workflow and occurrence: one reminder per invoice, one digest per Monday.
CREATE UNIQUE INDEX "workflow_runs_once_per_occurrence" ON "workflow_runs"("workflow_id", "occurrence_key") WHERE "status" <> 'TEST' AND "occurrence_key" IS NOT NULL;

ALTER TABLE "workflow_action_runs" DROP CONSTRAINT "workflow_action_runs_chk";
ALTER TABLE "workflow_action_runs" ADD CONSTRAINT "workflow_action_runs_chk" CHECK (
  "position" >= 0 AND "type" IN ('CREATE_TASK', 'WEBHOOK', 'SEND_EMAIL') AND jsonb_typeof("input") = 'object' AND jsonb_typeof("result") = 'object'
  AND "attempts" >= 0 AND "attempts" <= 20
  AND (("status" = 'PENDING') = ("finished_at" IS NULL))
  AND ("status" <> 'FAILED' OR "error" IS NOT NULL));

SELECT set_config('t2t.bypass', '', true);

CREATE OR REPLACE FUNCTION t2t_guard_workflow_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A workflow run cannot be removed' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status NOT IN ('RUNNING', 'FAILED') THEN RAISE EXCEPTION 'A finished workflow run cannot be changed' USING ERRCODE = 'P0001'; END IF;
  -- A failed run is changed only when one of its deliveries is retried.
  IF OLD.status = 'FAILED' AND NEW.status <> 'RUNNING' THEN RAISE EXCEPTION 'A failed workflow run can only be retried' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.workflow_id <> OLD.workflow_id OR NEW.version <> OLD.version OR NEW.trigger <> OLD.trigger
     OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.occurrence_key IS DISTINCT FROM OLD.occurrence_key
     OR NEW.facts <> OLD.facts OR NEW.conditions <> OLD.conditions OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A workflow run keeps what it ran on' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
