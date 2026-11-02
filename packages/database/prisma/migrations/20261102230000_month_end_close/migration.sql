-- Month-end close (M5 slice 5): a close per period, certifications, AI reviews and the adjusting entries they propose.

-- CreateEnum
CREATE TYPE "PeriodCloseStatus" AS ENUM ('IN_PROGRESS', 'CLOSED');

-- CreateEnum
CREATE TYPE "CloseReviewStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "CloseAdjustmentStatus" AS ENUM ('READY', 'POSTED', 'REJECTED', 'SUPERSEDED');

-- AlterEnum
ALTER TYPE "JournalSource" ADD VALUE 'CLOSE';

-- CreateTable
CREATE TABLE "period_closes" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "status" "PeriodCloseStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_by_id" UUID NOT NULL,
    "tasks" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "period_closes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "close_certifications" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "close_id" UUID NOT NULL,
    "certified_by_id" UUID NOT NULL,
    "certified_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" VARCHAR(2000),
    "checks" JSONB NOT NULL,
    "totals" JSONB NOT NULL,
    "reopened_by_id" UUID,
    "reopened_at" TIMESTAMPTZ(6),
    "reopen_reason" VARCHAR(2000),

    CONSTRAINT "close_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "close_ai_reviews" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "close_id" UUID NOT NULL,
    "status" "CloseReviewStatus" NOT NULL DEFAULT 'RUNNING',
    "started_by_id" UUID NOT NULL,
    "context" JSONB NOT NULL,
    "summary" TEXT,
    "findings" JSONB,
    "model" TEXT NOT NULL,
    "served_model" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "close_ai_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "close_adjustments" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "close_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "status" "CloseAdjustmentStatus" NOT NULL DEFAULT 'READY',
    "proposal" JSONB NOT NULL,
    "resolved" JSONB,
    "checks" JSONB NOT NULL,
    "confidence" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "journal_entry_id" UUID,
    "reversal_entry_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "close_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "period_closes_period_id_key" ON "period_closes"("period_id");

-- CreateIndex
CREATE INDEX "period_closes_org_id_status_idx" ON "period_closes"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "period_closes_period_id_org_id_key" ON "period_closes"("period_id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "period_closes_id_org_id_key" ON "period_closes"("id", "org_id");

-- CreateIndex
CREATE INDEX "close_certifications_org_id_close_id_idx" ON "close_certifications"("org_id", "close_id");

-- CreateIndex
CREATE INDEX "close_ai_reviews_org_id_close_id_created_at_idx" ON "close_ai_reviews"("org_id", "close_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "close_ai_reviews_id_org_id_key" ON "close_ai_reviews"("id", "org_id");

-- CreateIndex
CREATE INDEX "close_adjustments_org_id_close_id_status_idx" ON "close_adjustments"("org_id", "close_id", "status");

-- AddForeignKey
ALTER TABLE "period_closes" ADD CONSTRAINT "period_closes_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "period_closes" ADD CONSTRAINT "period_closes_period_id_org_id_fkey" FOREIGN KEY ("period_id", "org_id") REFERENCES "fiscal_periods"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_certifications" ADD CONSTRAINT "close_certifications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_certifications" ADD CONSTRAINT "close_certifications_close_id_org_id_fkey" FOREIGN KEY ("close_id", "org_id") REFERENCES "period_closes"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_ai_reviews" ADD CONSTRAINT "close_ai_reviews_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_ai_reviews" ADD CONSTRAINT "close_ai_reviews_close_id_org_id_fkey" FOREIGN KEY ("close_id", "org_id") REFERENCES "period_closes"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_adjustments" ADD CONSTRAINT "close_adjustments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_adjustments" ADD CONSTRAINT "close_adjustments_close_id_org_id_fkey" FOREIGN KEY ("close_id", "org_id") REFERENCES "period_closes"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_adjustments" ADD CONSTRAINT "close_adjustments_review_id_org_id_fkey" FOREIGN KEY ("review_id", "org_id") REFERENCES "close_ai_reviews"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "close_adjustments" ADD CONSTRAINT "close_adjustments_journal_entry_id_org_id_fkey" FOREIGN KEY ("journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "close_adjustments" ADD CONSTRAINT "close_adjustments_reversal_entry_id_org_id_fkey" FOREIGN KEY ("reversal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tasks can point at a month-end close.
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_chk";
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_chk" CHECK (
  length(btrim("title")) > 0
  AND (("assignee_user_id" IS NULL) <> ("assignee_role" IS NULL))
  AND ("assignee_role" IS NULL OR "assignee_role" IN ('OWNER', 'ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER'))
  AND (("link_type" IS NULL) = ("link_id" IS NULL))
  AND ("link_type" IS NULL OR "link_type" IN ('DOCUMENT', 'PAYMENT', 'JOURNAL', 'EXPENSE_CLAIM', 'ALERT', 'PERIOD_CLOSE'))
  AND (("status" = 'OPEN') = ("closed_at" IS NULL))
  AND (("status" = 'OPEN') = ("closed_by_id" IS NULL))
  AND "updated_at" >= "created_at");

-- One AI review at a time per close.
CREATE UNIQUE INDEX "close_ai_reviews_one_running" ON "close_ai_reviews"("close_id") WHERE "status" = 'RUNNING';
-- At most one certification in force (not reopened) per close.
CREATE UNIQUE INDEX "close_certifications_one_current" ON "close_certifications"("close_id") WHERE "reopened_at" IS NULL;

ALTER TABLE "period_closes" ADD CONSTRAINT "period_closes_chk" CHECK (jsonb_typeof("tasks") = 'object');

ALTER TABLE "close_certifications" ADD CONSTRAINT "close_certifications_chk" CHECK (
  jsonb_typeof("checks") = 'array' AND jsonb_typeof("totals") = 'object'
  AND (("reopened_at" IS NULL) = ("reopened_by_id" IS NULL))
  AND (("reopened_at" IS NULL) = ("reopen_reason" IS NULL))
  AND ("reopen_reason" IS NULL OR length(btrim("reopen_reason")) >= 10));

ALTER TABLE "close_ai_reviews" ADD CONSTRAINT "close_ai_reviews_chk" CHECK (
  jsonb_typeof("context") = 'object'
  AND (("status" = 'RUNNING') = ("finished_at" IS NULL))
  AND ("status" <> 'DONE' OR ("summary" IS NOT NULL AND jsonb_typeof("findings") = 'array'))
  AND ("status" <> 'FAILED' OR ("error_code" IS NOT NULL AND "error_message" IS NOT NULL)));

ALTER TABLE "close_adjustments" ADD CONSTRAINT "close_adjustments_chk" CHECK (
  jsonb_typeof("proposal") = 'object' AND jsonb_typeof("checks") = 'array'
  AND "confidence" IN ('LOW', 'MEDIUM', 'HIGH') AND length(btrim("reason")) > 0
  -- Only an entry that passed its checks can be posted, and posting records the journal it made.
  AND ("status" <> 'POSTED' OR ("resolved" IS NOT NULL AND "journal_entry_id" IS NOT NULL))
  AND ("status" = 'POSTED' OR ("journal_entry_id" IS NULL AND "reversal_entry_id" IS NULL))
  AND (("status" IN ('POSTED', 'REJECTED')) = ("decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL)));

-- A certification is the record of a close: only the reopening may be added, once.
CREATE OR REPLACE FUNCTION t2t_guard_close_certification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A close certification cannot be removed' USING ERRCODE = 'P0001'; END IF;
  IF OLD.reopened_at IS NOT NULL THEN RAISE EXCEPTION 'A reopened close certification cannot be changed' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.close_id <> OLD.close_id OR NEW.certified_by_id <> OLD.certified_by_id OR NEW.certified_at <> OLD.certified_at
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.checks <> OLD.checks OR NEW.totals <> OLD.totals THEN
    RAISE EXCEPTION 'What a close certification records cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER close_certifications_guard BEFORE UPDATE OR DELETE ON "close_certifications" FOR EACH ROW EXECUTE FUNCTION t2t_guard_close_certification();

CREATE OR REPLACE FUNCTION t2t_guard_period_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A month-end close cannot be removed' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.period_id <> OLD.period_id OR NEW.started_by_id <> OLD.started_by_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A month-end close keeps its period and who started it' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER period_closes_guard BEFORE UPDATE OR DELETE ON "period_closes" FOR EACH ROW EXECUTE FUNCTION t2t_guard_period_close();

CREATE OR REPLACE FUNCTION t2t_guard_close_ai_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An AI close review cannot be removed' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status <> 'RUNNING' THEN RAISE EXCEPTION 'A finished AI close review cannot be changed' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.close_id <> OLD.close_id OR NEW.started_by_id <> OLD.started_by_id OR NEW.context <> OLD.context
     OR NEW.model <> OLD.model OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An AI close review keeps what the model was shown' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER close_ai_reviews_guard BEFORE UPDATE OR DELETE ON "close_ai_reviews" FOR EACH ROW EXECUTE FUNCTION t2t_guard_close_ai_review();

-- An adjusting entry keeps what the model proposed; a decided one never changes; none is deleted.
CREATE OR REPLACE FUNCTION t2t_guard_close_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A proposed adjusting entry cannot be removed; reject it instead' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status <> 'READY' THEN RAISE EXCEPTION 'A posted, rejected or superseded adjusting entry cannot be changed' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.close_id <> OLD.close_id OR NEW.review_id <> OLD.review_id OR NEW.proposal <> OLD.proposal
     OR NEW.resolved IS DISTINCT FROM OLD.resolved OR NEW.checks <> OLD.checks OR NEW.confidence <> OLD.confidence OR NEW.reason <> OLD.reason
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'What the AI model proposed cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER close_adjustments_guard BEFORE UPDATE OR DELETE ON "close_adjustments" FOR EACH ROW EXECUTE FUNCTION t2t_guard_close_adjustment();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['period_closes', 'close_certifications', 'close_ai_reviews', 'close_adjustments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
