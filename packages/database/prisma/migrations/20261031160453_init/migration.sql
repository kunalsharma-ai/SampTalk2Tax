-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'LOCKED', 'CLOSED');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('DRAFT', 'POSTED');

-- CreateEnum
CREATE TYPE "JournalType" AS ENUM ('STANDARD', 'ADJUSTING', 'REVERSING', 'OPENING', 'CLOSING', 'RECURRING');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "country_code" CHAR(2) NOT NULL,
    "functional_currency" CHAR(3) NOT NULL,
    "fiscal_year_start_month" SMALLINT NOT NULL,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "subtype" TEXT,
    "description" TEXT,
    "parent_id" UUID,
    "is_postable" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_periods" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "period_no" SMALLINT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "locked_at" TIMESTAMPTZ(6),
    "locked_by_id" UUID,

    CONSTRAINT "fiscal_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "entry_number" INTEGER,
    "date" DATE NOT NULL,
    "period_id" UUID NOT NULL,
    "type" "JournalType" NOT NULL DEFAULT 'STANDARD',
    "status" "JournalStatus" NOT NULL DEFAULT 'DRAFT',
    "memo" TEXT,
    "reference" TEXT,
    "functional_currency" CHAR(3) NOT NULL,
    "total_debit" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "total_credit" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "idempotency_key" TEXT,
    "idempotency_hash" TEXT,
    "reverses_entry_id" UUID,
    "created_by_id" UUID NOT NULL,
    "posted_by_id" UUID,
    "posted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "account_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "exchange_rate" DECIMAL(24,10) NOT NULL,
    "debit" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "credit" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "functional_debit" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "functional_credit" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "description" TEXT,
    "dimensions" JSONB,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_counters" (
    "org_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "org_counters_pkey" PRIMARY KEY ("org_id","key")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" BIGSERIAL NOT NULL,
    "org_id" UUID,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "data" JSONB,
    "prev_hash" TEXT,
    "hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_org_id_user_id_key" ON "memberships"("org_id", "user_id");

-- CreateIndex
CREATE INDEX "accounts_org_id_type_idx" ON "accounts"("org_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_org_id_code_key" ON "accounts"("org_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_id_org_id_key" ON "accounts"("id", "org_id");

-- CreateIndex
CREATE INDEX "fiscal_periods_org_id_start_date_idx" ON "fiscal_periods"("org_id", "start_date");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_periods_org_id_fiscal_year_period_no_key" ON "fiscal_periods"("org_id", "fiscal_year", "period_no");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_periods_id_org_id_key" ON "fiscal_periods"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reverses_entry_id_key" ON "journal_entries"("reverses_entry_id");

-- CreateIndex
CREATE INDEX "journal_entries_org_id_date_idx" ON "journal_entries"("org_id", "date");

-- CreateIndex
CREATE INDEX "journal_entries_org_id_status_idx" ON "journal_entries"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_org_id_entry_number_key" ON "journal_entries"("org_id", "entry_number");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_org_id_idempotency_key_key" ON "journal_entries"("org_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_id_org_id_key" ON "journal_entries"("id", "org_id");

-- CreateIndex
CREATE INDEX "journal_lines_org_id_account_id_idx" ON "journal_lines"("org_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_entry_id_line_no_key" ON "journal_lines"("entry_id", "line_no");

-- CreateIndex
CREATE INDEX "audit_events_org_id_created_at_idx" ON "audit_events"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_org_id_entity_type_entity_id_idx" ON "audit_events"("org_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_org_id_fkey" FOREIGN KEY ("parent_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period_id_org_id_fkey" FOREIGN KEY ("period_id", "org_id") REFERENCES "fiscal_periods"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_org_id_fkey" FOREIGN KEY ("entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_org_id_fkey" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_counters" ADD CONSTRAINT "org_counters_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- Hand-written financial integrity controls (defence in depth).
-- The application validates all of these first; the database refuses
-- anything that slips past it.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Line amounts: non-negative, exactly one side positive, positive rate.
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_amounts_chk" CHECK (
    debit >= 0 AND credit >= 0 AND functional_debit >= 0 AND functional_credit >= 0
    AND ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
    AND ((functional_debit = 0) OR (debit > 0))
    AND ((functional_credit = 0) OR (credit > 0))
    AND exchange_rate > 0
  );

ALTER TABLE "fiscal_periods"
  ADD CONSTRAINT "fiscal_periods_dates_chk" CHECK (start_date <= end_date),
  ADD CONSTRAINT "fiscal_periods_no_overlap" EXCLUDE USING gist (
    org_id WITH =, daterange(start_date, end_date, '[]') WITH &&
  );

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_fy_month_chk" CHECK (fiscal_year_start_month BETWEEN 1 AND 12);

ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_posted_fields_chk" CHECK (
    status = 'DRAFT' OR (entry_number IS NOT NULL AND posted_at IS NOT NULL AND posted_by_id IS NOT NULL)
  ),
  ADD CONSTRAINT "journal_entries_totals_chk" CHECK (
    status = 'DRAFT' OR (total_debit = total_credit AND total_debit > 0)
  );

-- Posted entries are immutable; drafts may be edited or deleted.
CREATE OR REPLACE FUNCTION t2t_guard_journal_entry() RETURNS trigger AS $$
DECLARE
  p_status "PeriodStatus";
  p_start date;
  p_end date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'Posted journal entry % cannot be deleted; post a reversal instead', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'Posted journal entry % is immutable; post a reversal or adjustment instead', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'POSTED' THEN
    SELECT status, start_date, end_date INTO p_status, p_start, p_end
      FROM fiscal_periods WHERE id = NEW.period_id AND org_id = NEW.org_id;
    IF p_status IS DISTINCT FROM 'OPEN' THEN
      RAISE EXCEPTION 'Cannot post into a % period', COALESCE(p_status::text, 'missing') USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT start_date, end_date INTO p_start, p_end
      FROM fiscal_periods WHERE id = NEW.period_id AND org_id = NEW.org_id;
  END IF;

  IF NEW.date < p_start OR NEW.date > p_end THEN
    RAISE EXCEPTION 'Entry date % is outside its fiscal period (% to %)', NEW.date, p_start, p_end
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_journal_entry();

-- Lines may only change while their entry is a draft.
CREATE OR REPLACE FUNCTION t2t_guard_journal_line() RETURNS trigger AS $$
DECLARE
  e_status "JournalStatus";
  target uuid;
BEGIN
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
  SELECT status INTO e_status FROM journal_entries WHERE id = target;
  IF e_status = 'POSTED' THEN
    RAISE EXCEPTION 'Lines of posted journal entry % are immutable', target USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.entry_id <> NEW.entry_id THEN
    SELECT status INTO e_status FROM journal_entries WHERE id = OLD.entry_id;
    IF e_status = 'POSTED' THEN
      RAISE EXCEPTION 'Lines of posted journal entry % are immutable', OLD.entry_id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_journal_line();

-- At commit time, every posted entry must have >= 2 lines that balance in
-- functional currency and match the header totals.
CREATE OR REPLACE FUNCTION t2t_check_entry_balanced() RETURNS trigger AS $$
DECLARE
  d numeric;
  c numeric;
  n int;
BEGIN
  IF NEW.status <> 'POSTED' THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(functional_debit), 0), COALESCE(SUM(functional_credit), 0), COUNT(*)
    INTO d, c, n FROM journal_lines WHERE entry_id = NEW.id;
  IF n < 2 THEN
    RAISE EXCEPTION 'Posted journal entry % must have at least two lines', NEW.id USING ERRCODE = 'P0001';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'Posted journal entry % does not balance (debits %, credits %)', NEW.id, d, c USING ERRCODE = 'P0001';
  END IF;
  IF d <> NEW.total_debit OR c <> NEW.total_credit THEN
    RAISE EXCEPTION 'Posted journal entry % header totals do not match its lines', NEW.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION t2t_check_entry_balanced();

-- Posting to header or inactive accounts is refused.
CREATE OR REPLACE FUNCTION t2t_check_line_account() RETURNS trigger AS $$
DECLARE
  postable boolean;
  active boolean;
BEGIN
  SELECT is_postable, is_active INTO postable, active FROM accounts WHERE id = NEW.account_id AND org_id = NEW.org_id;
  IF NOT postable OR NOT active THEN
    RAISE EXCEPTION 'Account % is not postable or inactive', NEW.account_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_lines_account_check
  BEFORE INSERT OR UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION t2t_check_line_account();

-- Audit trail is append-only.
CREATE OR REPLACE FUNCTION t2t_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION t2t_audit_append_only();
