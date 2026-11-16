-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('SKIPPED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TEST');

-- CreateEnum
CREATE TYPE "WorkflowActionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "current_version" INTEGER NOT NULL,
    "active_from_event_id" BIGINT,
    "signing_secret" VARCHAR(100) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_versions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "trigger" VARCHAR(40) NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "note" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "trigger" VARCHAR(40) NOT NULL,
    "event_id" BIGINT,
    "entity_type" VARCHAR(40),
    "entity_id" VARCHAR(64),
    "facts" JSONB NOT NULL,
    "conditions" JSONB NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL,
    "error" VARCHAR(1000),
    "tested_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_action_runs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "status" "WorkflowActionStatus" NOT NULL,
    "input" JSONB NOT NULL,
    "result" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "locked_until" TIMESTAMPTZ(6),
    "error" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_action_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_cursors" (
    "org_id" UUID NOT NULL,
    "last_event_id" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_cursors_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "assignee_user_id" UUID,
    "assignee_role" VARCHAR(20),
    "due_date" DATE,
    "link_type" VARCHAR(20),
    "link_id" VARCHAR(64),
    "workflow_run_id" UUID,
    "created_by_id" UUID,
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "close_note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflows_org_id_enabled_idx" ON "workflows"("org_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_id_org_id_key" ON "workflows"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_workflow_id_version_key" ON "workflow_versions"("workflow_id", "version");

-- CreateIndex
CREATE INDEX "workflow_runs_org_id_workflow_id_created_at_idx" ON "workflow_runs"("org_id", "workflow_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_id_org_id_key" ON "workflow_runs"("id", "org_id");

-- CreateIndex
CREATE INDEX "workflow_action_runs_status_next_attempt_at_idx" ON "workflow_action_runs"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_action_runs_run_id_position_key" ON "workflow_action_runs"("run_id", "position");

-- CreateIndex
CREATE INDEX "tasks_org_id_status_idx" ON "tasks"("org_id", "status");

-- CreateIndex
CREATE INDEX "tasks_org_id_assignee_user_id_status_idx" ON "tasks"("org_id", "assignee_user_id", "status");

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_org_id_fkey" FOREIGN KEY ("workflow_id", "org_id") REFERENCES "workflows"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_org_id_fkey" FOREIGN KEY ("workflow_id", "org_id") REFERENCES "workflows"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_action_runs" ADD CONSTRAINT "workflow_action_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_action_runs" ADD CONSTRAINT "workflow_action_runs_run_id_org_id_fkey" FOREIGN KEY ("run_id", "org_id") REFERENCES "workflow_runs"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_cursors" ADD CONSTRAINT "workflow_cursors_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written guards.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workflow_run_fk" FOREIGN KEY ("workflow_run_id", "org_id") REFERENCES "workflow_runs"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workflows" ADD CONSTRAINT "workflows_chk" CHECK (
  length(btrim("name")) > 0 AND "current_version" >= 1 AND length("signing_secret") >= 32
  AND ("enabled" = false OR "active_from_event_id" IS NOT NULL) AND "updated_at" >= "created_at");

ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_chk" CHECK (
  "version" >= 1
  AND "trigger" IN ('INVOICE_POSTED', 'BILL_POSTED', 'DOCUMENT_VOIDED', 'RECEIPT_RECORDED', 'VENDOR_PAYMENT_RECORDED', 'JOURNAL_POSTED', 'EXPENSE_CLAIM_SUBMITTED', 'ALERT_OPENED')
  AND jsonb_typeof("conditions") = 'array' AND jsonb_array_length("conditions") <= 10
  AND jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") BETWEEN 1 AND 5);

ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_chk" CHECK (
  "version" >= 1 AND jsonb_typeof("facts") = 'object' AND jsonb_typeof("conditions") = 'array'
  AND (("status" = 'TEST') = ("tested_by_id" IS NOT NULL))
  AND ("status" = 'TEST' OR "event_id" IS NOT NULL)
  AND (("status" = 'RUNNING') = ("finished_at" IS NULL))
  AND ("status" <> 'FAILED' OR "error" IS NOT NULL));
-- A live run happens once per workflow and event, so the runner can never act twice on one event.
CREATE UNIQUE INDEX "workflow_runs_once_per_event" ON "workflow_runs"("workflow_id", "event_id") WHERE "status" <> 'TEST';

ALTER TABLE "workflow_action_runs" ADD CONSTRAINT "workflow_action_runs_chk" CHECK (
  "position" >= 0 AND "type" IN ('CREATE_TASK', 'WEBHOOK') AND jsonb_typeof("input") = 'object' AND jsonb_typeof("result") = 'object'
  AND "attempts" >= 0 AND "attempts" <= 20
  AND (("status" = 'PENDING') = ("finished_at" IS NULL))
  AND ("status" <> 'FAILED' OR "error" IS NOT NULL));

ALTER TABLE "workflow_cursors" ADD CONSTRAINT "workflow_cursors_chk" CHECK ("last_event_id" >= 0);

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_chk" CHECK (
  length(btrim("title")) > 0
  AND (("assignee_user_id" IS NULL) <> ("assignee_role" IS NULL))
  AND ("assignee_role" IS NULL OR "assignee_role" IN ('OWNER', 'ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER'))
  AND (("link_type" IS NULL) = ("link_id" IS NULL))
  AND ("link_type" IS NULL OR "link_type" IN ('DOCUMENT', 'PAYMENT', 'JOURNAL', 'EXPENSE_CLAIM', 'ALERT'))
  AND (("status" = 'OPEN') = ("closed_at" IS NULL))
  AND (("status" = 'OPEN') = ("closed_by_id" IS NULL))
  AND "updated_at" >= "created_at");

-- A version is the record of what a workflow did: never changed or removed.
CREATE OR REPLACE FUNCTION t2t_guard_workflow_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A workflow version cannot be changed or removed' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER workflow_versions_guard BEFORE UPDATE OR DELETE ON "workflow_versions" FOR EACH ROW EXECUTE FUNCTION t2t_guard_workflow_version();

CREATE OR REPLACE FUNCTION t2t_guard_workflow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A workflow cannot be removed; turn it off instead' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.created_by_id <> OLD.created_by_id OR NEW.created_at <> OLD.created_at OR NEW.current_version < OLD.current_version THEN
    RAISE EXCEPTION 'A workflow keeps its organisation, author and history' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflows_guard BEFORE UPDATE OR DELETE ON "workflows" FOR EACH ROW EXECUTE FUNCTION t2t_guard_workflow();

-- A run is a log entry: a running run is finished once; a failed run can go back to running for a retry.
CREATE OR REPLACE FUNCTION t2t_guard_workflow_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A workflow run cannot be removed' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status NOT IN ('RUNNING', 'FAILED') THEN RAISE EXCEPTION 'A finished workflow run cannot be changed' USING ERRCODE = 'P0001'; END IF;
  -- A failed run is changed only when one of its webhooks is retried.
  IF OLD.status = 'FAILED' AND NEW.status <> 'RUNNING' THEN RAISE EXCEPTION 'A failed workflow run can only be retried' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.workflow_id <> OLD.workflow_id OR NEW.version <> OLD.version OR NEW.trigger <> OLD.trigger
     OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.facts <> OLD.facts OR NEW.conditions <> OLD.conditions OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A workflow run keeps what it ran on' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_runs_guard BEFORE UPDATE OR DELETE ON "workflow_runs" FOR EACH ROW EXECUTE FUNCTION t2t_guard_workflow_run();

-- An action keeps what it was asked to do; a finished action is changed only to be retried (failed → pending).
CREATE OR REPLACE FUNCTION t2t_guard_workflow_action_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A workflow action cannot be removed' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.run_id <> OLD.run_id OR NEW.position <> OLD.position OR NEW.type <> OLD.type OR NEW.input <> OLD.input OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A workflow action keeps what it was asked to do' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('SUCCEEDED', 'SKIPPED') THEN RAISE EXCEPTION 'A finished workflow action cannot be changed' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status = 'FAILED' AND NEW.status NOT IN ('FAILED', 'PENDING') THEN RAISE EXCEPTION 'A failed workflow action can only be retried' USING ERRCODE = 'P0001'; END IF;
  IF NEW.attempts < OLD.attempts THEN RAISE EXCEPTION 'Attempts only go up' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_action_runs_guard BEFORE UPDATE OR DELETE ON "workflow_action_runs" FOR EACH ROW EXECUTE FUNCTION t2t_guard_workflow_action_run();

CREATE OR REPLACE FUNCTION t2t_guard_workflow_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_event_id < OLD.last_event_id THEN RAISE EXCEPTION 'The workflow cursor only moves forward' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_cursors_guard BEFORE UPDATE ON "workflow_cursors" FOR EACH ROW EXECUTE FUNCTION t2t_guard_workflow_cursor();

-- A task is closed once and keeps where it came from.
CREATE OR REPLACE FUNCTION t2t_guard_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A task cannot be removed; cancel it instead' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status <> 'OPEN' THEN RAISE EXCEPTION 'A closed task cannot be changed' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
     OR NEW.link_type IS DISTINCT FROM OLD.link_type OR NEW.link_id IS DISTINCT FROM OLD.link_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A task keeps where it came from' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_guard BEFORE UPDATE OR DELETE ON "tasks" FOR EACH ROW EXECUTE FUNCTION t2t_guard_task();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflows', 'workflow_versions', 'workflow_runs', 'workflow_action_runs', 'workflow_cursors', 'tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
