-- Where each task came from.
ALTER TABLE "tasks" ADD COLUMN "source" VARCHAR(20) NOT NULL DEFAULT 'PERSON';
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_check" CHECK ("source" IN ('PERSON', 'WORKFLOW', 'AI_AGENT', 'ALERT', 'CLOSE'));
CREATE INDEX "tasks_org_id_source_status_idx" ON "tasks"("org_id", "source", "status");
CREATE INDEX "tasks_org_id_link_type_link_id_idx" ON "tasks"("org_id", "link_type", "link_id");

-- Existing tasks: RLS is forced, so the update runs with the bypass on.
-- Closed tasks are otherwise locked by tasks_guard; only the new column is being filled in.
SELECT set_config('t2t.bypass', 'on', true);
ALTER TABLE "tasks" DISABLE TRIGGER "tasks_guard";
UPDATE "tasks" SET "source" = 'WORKFLOW' WHERE "workflow_run_id" IS NOT NULL;
UPDATE "tasks" SET "source" = 'CLOSE' WHERE "workflow_run_id" IS NULL AND "link_type" = 'PERIOD_CLOSE';
-- Tasks the copilot proposed and the member confirmed: same organisation, member and title, created as the action was decided.
UPDATE "tasks" t SET "source" = 'AI_AGENT'
FROM "copilot_actions" a
WHERE a."org_id" = t."org_id" AND a."kind" = 'CREATE_TASK' AND a."status" = 'DONE' AND t."created_by_id" = a."user_id"
  AND t."title" = left(btrim(a."input"->>'title'), 200) AND t."workflow_run_id" IS NULL
  AND abs(extract(epoch FROM (t."created_at" - a."decided_at"))) < 60;
ALTER TABLE "tasks" ENABLE TRIGGER "tasks_guard";

-- Who hears about new alerts: open alerts at or above a severity become a task for a role.
CREATE TABLE "alert_notification_settings" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "min_severity" VARCHAR(10) NOT NULL,
    "task_role" VARCHAR(20) NOT NULL,
    "due_days" INTEGER NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alert_notification_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "alert_notification_settings_org_id_key" ON "alert_notification_settings"("org_id");
ALTER TABLE "alert_notification_settings" ADD CONSTRAINT "alert_notification_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "alert_notification_settings" ADD CONSTRAINT "alert_notification_settings_check" CHECK ("min_severity" IN ('CRITICAL', 'WARNING', 'OFF') AND "task_role" IN ('OWNER', 'ADMIN', 'ACCOUNTANT', 'APPROVER') AND "due_days" BETWEEN 0 AND 30);
ALTER TABLE "alert_notification_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alert_notification_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "alert_notification_settings" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
