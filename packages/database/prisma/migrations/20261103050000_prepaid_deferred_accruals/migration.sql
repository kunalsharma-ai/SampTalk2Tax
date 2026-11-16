-- Prepaid expenses and deferred revenue schedules with monthly release runs, and month-end accruals that reverse automatically.

-- CreateEnum
CREATE TYPE "DeferralKind" AS ENUM ('PREPAID_EXPENSE', 'DEFERRED_REVENUE');

-- CreateEnum
CREATE TYPE "DeferralMethod" AS ENUM ('EVEN', 'DAILY');

-- CreateEnum
CREATE TYPE "DeferralStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "DeferralRunStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "AccrualKind" AS ENUM ('EXPENSE', 'INCOME');

-- CreateEnum
CREATE TYPE "AccrualStatus" AS ENUM ('POSTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'DEFERRAL';
ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'ACCRUAL';

-- CreateTable
CREATE TABLE "deferral_schedules" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" "DeferralKind" NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "counterparty" VARCHAR(200),
    "balance_account_id" UUID NOT NULL,
    "pnl_account_id" UUID NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "start_date" DATE NOT NULL,
    "months" INTEGER NOT NULL,
    "method" "DeferralMethod" NOT NULL,
    "initial_entry_id" UUID,
    "status" "DeferralStatus" NOT NULL DEFAULT 'ACTIVE',
    "ended_on" DATE,
    "end_amount" DECIMAL(24,6),
    "end_entry_id" UUID,
    "end_note" VARCHAR(500),
    "ended_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deferral_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deferral_runs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "status" "DeferralRunStatus" NOT NULL DEFAULT 'POSTED',
    "total" DECIMAL(24,6) NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "posted_by_id" UUID NOT NULL,
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversal_entry_id" UUID,
    "reversed_by_id" UUID,
    "reversed_at" TIMESTAMPTZ(6),

    CONSTRAINT "deferral_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deferral_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,

    CONSTRAINT "deferral_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accruals" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" "AccrualKind" NOT NULL,
    "number" INTEGER NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "counterparty" VARCHAR(200),
    "month" VARCHAR(7) NOT NULL,
    "pnl_account_id" UUID NOT NULL,
    "balance_account_id" UUID NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "entry_id" UUID NOT NULL,
    "reversal_entry_id" UUID NOT NULL,
    "status" "AccrualStatus" NOT NULL DEFAULT 'POSTED',
    "cancel_entry_id" UUID,
    "cancel_reversal_entry_id" UUID,
    "cancel_note" VARCHAR(500),
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accruals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deferral_schedules_org_id_status_idx" ON "deferral_schedules"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "deferral_schedules_org_id_kind_number_key" ON "deferral_schedules"("org_id", "kind", "number");

-- CreateIndex
CREATE UNIQUE INDEX "deferral_schedules_id_org_id_key" ON "deferral_schedules"("id", "org_id");

-- CreateIndex
CREATE INDEX "deferral_runs_org_id_month_idx" ON "deferral_runs"("org_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "deferral_runs_id_org_id_key" ON "deferral_runs"("id", "org_id");

-- CreateIndex
CREATE INDEX "deferral_lines_org_id_schedule_id_idx" ON "deferral_lines"("org_id", "schedule_id");

-- CreateIndex
CREATE UNIQUE INDEX "deferral_lines_run_id_schedule_id_month_key" ON "deferral_lines"("run_id", "schedule_id", "month");

-- CreateIndex
CREATE INDEX "accruals_org_id_month_idx" ON "accruals"("org_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "accruals_org_id_number_key" ON "accruals"("org_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "accruals_id_org_id_key" ON "accruals"("id", "org_id");

-- AddForeignKey
ALTER TABLE "deferral_schedules" ADD CONSTRAINT "deferral_schedules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deferral_runs" ADD CONSTRAINT "deferral_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deferral_lines" ADD CONSTRAINT "deferral_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deferral_lines" ADD CONSTRAINT "deferral_lines_run_id_org_id_fkey" FOREIGN KEY ("run_id", "org_id") REFERENCES "deferral_runs"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deferral_lines" ADD CONSTRAINT "deferral_lines_schedule_id_org_id_fkey" FOREIGN KEY ("schedule_id", "org_id") REFERENCES "deferral_schedules"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deferral_schedules" ADD CONSTRAINT "deferral_schedules_balance_account_fk" FOREIGN KEY ("balance_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deferral_schedules" ADD CONSTRAINT "deferral_schedules_pnl_account_fk" FOREIGN KEY ("pnl_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deferral_schedules" ADD CONSTRAINT "deferral_schedules_initial_entry_fk" FOREIGN KEY ("initial_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deferral_schedules" ADD CONSTRAINT "deferral_schedules_end_entry_fk" FOREIGN KEY ("end_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deferral_runs" ADD CONSTRAINT "deferral_runs_journal_fk" FOREIGN KEY ("journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deferral_runs" ADD CONSTRAINT "deferral_runs_reversal_fk" FOREIGN KEY ("reversal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_pnl_account_fk" FOREIGN KEY ("pnl_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_balance_account_fk" FOREIGN KEY ("balance_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_entry_fk" FOREIGN KEY ("entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_reversal_entry_fk" FOREIGN KEY ("reversal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_cancel_entry_fk" FOREIGN KEY ("cancel_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_cancel_reversal_entry_fk" FOREIGN KEY ("cancel_reversal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One posted release run per month.
CREATE UNIQUE INDEX "deferral_runs_one_posted" ON "deferral_runs"("org_id", "month") WHERE status = 'POSTED';

ALTER TABLE "deferral_schedules" ADD CONSTRAINT "deferral_schedules_chk" CHECK (
  number > 0 AND length(btrim(name)) > 0 AND amount > 0 AND months BETWEEN 1 AND 120
  AND balance_account_id <> pnl_account_id
  AND ((status = 'ACTIVE' AND ended_on IS NULL AND end_amount IS NULL AND end_entry_id IS NULL AND ended_by_id IS NULL)
    OR (status = 'ENDED' AND ended_on IS NOT NULL AND ended_on >= start_date AND end_amount >= 0 AND end_amount <= amount AND ended_by_id IS NOT NULL
        AND (end_amount = 0) = (end_entry_id IS NULL)))
);
ALTER TABLE "deferral_runs" ADD CONSTRAINT "deferral_runs_chk" CHECK (
  month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND total > 0
  AND ((status = 'POSTED' AND reversal_entry_id IS NULL AND reversed_by_id IS NULL AND reversed_at IS NULL)
    OR (status = 'REVERSED' AND reversal_entry_id IS NOT NULL AND reversed_by_id IS NOT NULL AND reversed_at IS NOT NULL))
);
ALTER TABLE "deferral_lines" ADD CONSTRAINT "deferral_lines_chk" CHECK (amount > 0 AND month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "accruals" ADD CONSTRAINT "accruals_chk" CHECK (
  number > 0 AND length(btrim(description)) > 0 AND amount > 0 AND month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  AND balance_account_id <> pnl_account_id AND entry_id <> reversal_entry_id
  AND ((status = 'POSTED' AND cancelled_by_id IS NULL AND cancelled_at IS NULL AND cancel_entry_id IS NULL AND cancel_reversal_entry_id IS NULL)
    OR (status = 'CANCELLED' AND cancelled_by_id IS NOT NULL AND cancelled_at IS NOT NULL AND cancel_entry_id IS NOT NULL AND cancel_reversal_entry_id IS NOT NULL))
);

-- Schedules are never deleted; their terms are fixed once a release is posted, and an ended schedule is final.
CREATE FUNCTION t2t_guard_deferral_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Prepaid and deferred revenue schedules are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.kind <> OLD.kind OR NEW.number <> OLD.number OR NEW.created_by_id <> OLD.created_by_id OR NEW.initial_entry_id IS DISTINCT FROM OLD.initial_entry_id THEN
    RAISE EXCEPTION 'A schedule keeps its organisation, kind, number and opening entry' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'ENDED' THEN
    RAISE EXCEPTION 'An ended schedule cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM deferral_lines l WHERE l.schedule_id = OLD.id) AND (
    NEW.amount <> OLD.amount OR NEW.start_date <> OLD.start_date OR NEW.months <> OLD.months OR NEW.method <> OLD.method
    OR NEW.balance_account_id <> OLD.balance_account_id OR NEW.pnl_account_id <> OLD.pnl_account_id
  ) THEN
    RAISE EXCEPTION 'A release has been posted for this schedule, so its amount, dates, accounts and method are fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deferral_schedules_guard BEFORE UPDATE OR DELETE ON "deferral_schedules" FOR EACH ROW EXECUTE FUNCTION t2t_guard_deferral_schedule();

-- Runs are never deleted; a posted run changes only to record its reversal.
CREATE FUNCTION t2t_guard_deferral_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Release runs are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'REVERSED' OR NEW.status <> 'REVERSED' OR NEW.org_id <> OLD.org_id OR NEW.month <> OLD.month OR NEW.total <> OLD.total
     OR NEW.journal_entry_id <> OLD.journal_entry_id OR NEW.posted_by_id <> OLD.posted_by_id OR NEW.posted_at <> OLD.posted_at THEN
    RAISE EXCEPTION 'A release run changes only to record its reversal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deferral_runs_guard BEFORE UPDATE OR DELETE ON "deferral_runs" FOR EACH ROW EXECUTE FUNCTION t2t_guard_deferral_run();

CREATE FUNCTION t2t_guard_deferral_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Release lines are never changed or deleted' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER deferral_lines_guard BEFORE UPDATE OR DELETE ON "deferral_lines" FOR EACH ROW EXECUTE FUNCTION t2t_guard_deferral_line();

-- Accruals are never deleted; a posted accrual changes only to record that it was cancelled.
CREATE FUNCTION t2t_guard_accrual() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Accruals are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'CANCELLED' OR NEW.status <> 'CANCELLED' OR NEW.org_id <> OLD.org_id OR NEW.number <> OLD.number OR NEW.kind <> OLD.kind
     OR NEW.month <> OLD.month OR NEW.amount <> OLD.amount OR NEW.pnl_account_id <> OLD.pnl_account_id OR NEW.balance_account_id <> OLD.balance_account_id
     OR NEW.entry_id <> OLD.entry_id OR NEW.reversal_entry_id <> OLD.reversal_entry_id OR NEW.created_by_id <> OLD.created_by_id THEN
    RAISE EXCEPTION 'An accrual changes only to record that it was cancelled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accruals_guard BEFORE UPDATE OR DELETE ON "accruals" FOR EACH ROW EXECUTE FUNCTION t2t_guard_accrual();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['deferral_schedules', 'deferral_runs', 'deferral_lines', 'accruals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
