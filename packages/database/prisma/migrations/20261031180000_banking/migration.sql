-- CreateEnum
CREATE TYPE "StatementLineStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "BankMatchOrigin" AS ENUM ('EXISTING', 'CREATED_ENTRY', 'CREATED_PAYMENT');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('COMPLETED', 'UNDONE');

-- AlterEnum
ALTER TYPE "JournalSource" ADD VALUE 'BANK';

-- CreateTable
CREATE TABLE "bank_statement_imports" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "skipped_count" INTEGER NOT NULL,
    "first_date" DATE NOT NULL,
    "last_date" DATE NOT NULL,
    "imported_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amount" DECIMAL(24,6) NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "StatementLineStatus" NOT NULL DEFAULT 'UNMATCHED',
    "excluded_reason" TEXT,
    "reconciliation_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_matches" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "statement_line_id" UUID NOT NULL,
    "journal_line_id" UUID NOT NULL,
    "origin" "BankMatchOrigin" NOT NULL DEFAULT 'EXISTING',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),
    "removed_by_id" UUID,

    CONSTRAINT "bank_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_reconciliations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "statement_date" DATE NOT NULL,
    "opening_balance" DECIMAL(24,6) NOT NULL,
    "statement_balance" DECIMAL(24,6) NOT NULL,
    "ledger_balance" DECIMAL(24,6) NOT NULL,
    "uncleared" DECIMAL(24,6) NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'COMPLETED',
    "completed_by_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_by_id" UUID,
    "undone_at" TIMESTAMPTZ(6),
    "undo_reason" TEXT,

    CONSTRAINT "bank_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_statement_imports_org_id_account_id_idx" ON "bank_statement_imports"("org_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_imports_id_org_id_key" ON "bank_statement_imports"("id", "org_id");

-- CreateIndex
CREATE INDEX "bank_statement_lines_org_id_account_id_date_idx" ON "bank_statement_lines"("org_id", "account_id", "date");

-- CreateIndex
CREATE INDEX "bank_statement_lines_org_id_account_id_status_idx" ON "bank_statement_lines"("org_id", "account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_org_id_account_id_fingerprint_key" ON "bank_statement_lines"("org_id", "account_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_id_org_id_key" ON "bank_statement_lines"("id", "org_id");

-- CreateIndex
CREATE INDEX "bank_matches_org_id_statement_line_id_idx" ON "bank_matches"("org_id", "statement_line_id");

-- CreateIndex
CREATE INDEX "bank_matches_org_id_journal_line_id_idx" ON "bank_matches"("org_id", "journal_line_id");

-- CreateIndex
CREATE INDEX "bank_reconciliations_org_id_account_id_statement_date_idx" ON "bank_reconciliations"("org_id", "account_id", "statement_date");

-- CreateIndex
CREATE UNIQUE INDEX "bank_reconciliations_id_org_id_key" ON "bank_reconciliations"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_id_org_id_key" ON "journal_lines"("id", "org_id");

-- AddForeignKey
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_account_id_org_id_fkey" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_account_id_org_id_fkey" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_import_id_org_id_fkey" FOREIGN KEY ("import_id", "org_id") REFERENCES "bank_statement_imports"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_reconciliation_id_org_id_fkey" FOREIGN KEY ("reconciliation_id", "org_id") REFERENCES "bank_reconciliations"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_statement_line_id_org_id_fkey" FOREIGN KEY ("statement_line_id", "org_id") REFERENCES "bank_statement_lines"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_journal_line_id_org_id_fkey" FOREIGN KEY ("journal_line_id", "org_id") REFERENCES "journal_lines"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_account_id_org_id_fkey" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written integrity controls for banking and reconciliation.
-- ---------------------------------------------------------------------------

ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_amount_chk" CHECK ("amount" <> 0),
  ADD CONSTRAINT "bank_statement_lines_excluded_chk" CHECK (("status" = 'EXCLUDED') = ("excluded_reason" IS NOT NULL));
ALTER TABLE "bank_statement_imports"
  ADD CONSTRAINT "bank_statement_imports_counts_chk" CHECK ("line_count" >= 0 AND "skipped_count" >= 0 AND "first_date" <= "last_date");
ALTER TABLE "bank_reconciliations"
  ADD CONSTRAINT "bank_reconciliations_dates_chk" CHECK ("start_date" <= "statement_date"),
  ADD CONSTRAINT "bank_reconciliations_undo_chk" CHECK (("status" = 'UNDONE') = ("undone_at" IS NOT NULL));

-- A journal line can be matched to at most one statement line at a time.
CREATE UNIQUE INDEX "bank_matches_active_journal_line_uniq" ON "bank_matches" ("journal_line_id") WHERE "removed_at" IS NULL;
-- At most one completed reconciliation per account and statement date.
CREATE UNIQUE INDEX "bank_reconciliations_completed_uniq" ON "bank_reconciliations" ("org_id", "account_id", "statement_date") WHERE "status" = 'COMPLETED';

-- Entries created from a bank line are not manual journals, but they still may not
-- touch the receivables/payables control accounts (use a receipt or payment instead).
CREATE OR REPLACE FUNCTION t2t_check_control_account() RETURNS trigger AS $$
DECLARE
  src "JournalSource";
  ar uuid;
  ap uuid;
BEGIN
  SELECT source INTO src FROM journal_entries WHERE id = NEW.entry_id;
  IF src::text IN ('MANUAL', 'BANK') THEN
    SELECT ar_account_id, ap_account_id INTO ar, ap FROM organizations WHERE id = NEW.org_id;
    IF NEW.account_id = ar OR NEW.account_id = ap THEN
      RAISE EXCEPTION 'Account % is a receivables/payables control account; Cannot post a manual journal to it', NEW.account_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Statement lines are never deleted; what the bank said never changes; reconciled
-- lines are frozen until their reconciliation is undone.
CREATE OR REPLACE FUNCTION t2t_guard_statement_line() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bank statement line % cannot be deleted; exclude it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.account_id <> OLD.account_id OR NEW.import_id <> OLD.import_id OR NEW.date <> OLD.date OR NEW.amount <> OLD.amount
     OR NEW.description <> OLD.description OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.fingerprint <> OLD.fingerprint THEN
    RAISE EXCEPTION 'Bank statement line % cannot be changed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.reconciliation_id IS NOT NULL AND NEW.reconciliation_id IS NOT DISTINCT FROM OLD.reconciliation_id
     AND (NEW.status <> OLD.status OR NEW.excluded_reason IS DISTINCT FROM OLD.excluded_reason) THEN
    RAISE EXCEPTION 'Bank statement line % is reconciled; undo the reconciliation first', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.reconciliation_id IS NOT NULL AND OLD.reconciliation_id IS NULL AND NEW.status = 'UNMATCHED' THEN
    RAISE EXCEPTION 'Bank statement line % is not matched and cannot be reconciled', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bank_statement_lines_guard
  BEFORE UPDATE OR DELETE ON "bank_statement_lines"
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_statement_line();

-- Matches are history: never deleted, only removed once, and not while reconciled.
CREATE OR REPLACE FUNCTION t2t_guard_bank_match() RETURNS trigger AS $$
DECLARE
  rec uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bank match % cannot be deleted; unmatch it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.statement_line_id <> OLD.statement_line_id OR NEW.journal_line_id <> OLD.journal_line_id OR NEW.origin <> OLD.origin
     OR NEW.created_by_id <> OLD.created_by_id OR NEW.created_at <> OLD.created_at
     OR (OLD.removed_at IS NOT NULL AND (NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.removed_by_id IS DISTINCT FROM OLD.removed_by_id)) THEN
    RAISE EXCEPTION 'Bank match % cannot be changed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  SELECT reconciliation_id INTO rec FROM bank_statement_lines WHERE id = OLD.statement_line_id;
  IF rec IS NOT NULL THEN
    RAISE EXCEPTION 'Bank match % belongs to a reconciled line; undo the reconciliation first', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bank_matches_guard
  BEFORE UPDATE OR DELETE ON "bank_matches"
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_bank_match();

-- At commit: a MATCHED line's active matches are posted lines on the same bank account
-- whose net equals the statement amount; other lines have no active matches.
CREATE OR REPLACE FUNCTION t2t_check_statement_line_matches() RETURNS trigger AS $$
DECLARE
  line_id uuid;
  l record;
  n int;
  net numeric;
  bad int;
BEGIN
  IF TG_TABLE_NAME = 'bank_matches' THEN line_id := NEW.statement_line_id; ELSE line_id := NEW.id; END IF;
  SELECT * INTO l FROM bank_statement_lines WHERE id = line_id;
  SELECT count(*), coalesce(sum(jl.functional_debit - jl.functional_credit), 0),
         count(*) FILTER (WHERE jl.account_id <> l.account_id OR jl.org_id <> l.org_id OR je.status <> 'POSTED')
    INTO n, net, bad
    FROM bank_matches m
    JOIN journal_lines jl ON jl.id = m.journal_line_id
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE m.statement_line_id = line_id AND m.removed_at IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION 'Bank statement line % is matched to a ledger line on a different account or not posted', line_id USING ERRCODE = 'P0001';
  END IF;
  IF l.status = 'MATCHED' AND (n = 0 OR net <> l.amount) THEN
    RAISE EXCEPTION 'Bank statement line % amount % does not equal its matched ledger lines %', line_id, l.amount, net USING ERRCODE = 'P0001';
  END IF;
  IF l.status <> 'MATCHED' AND n > 0 THEN
    RAISE EXCEPTION 'Bank statement line % has matches but is %', line_id, l.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER bank_matches_checked
  AFTER INSERT OR UPDATE ON "bank_matches"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION t2t_check_statement_line_matches();

CREATE CONSTRAINT TRIGGER bank_statement_lines_checked
  AFTER INSERT OR UPDATE ON "bank_statement_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION t2t_check_statement_line_matches();

-- Reconciliation records are never deleted; a completed one can only be undone once.
CREATE OR REPLACE FUNCTION t2t_guard_reconciliation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reconciliation % cannot be deleted; undo it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'UNDONE' OR NEW.account_id <> OLD.account_id OR NEW.start_date <> OLD.start_date OR NEW.statement_date <> OLD.statement_date
     OR NEW.opening_balance <> OLD.opening_balance OR NEW.statement_balance <> OLD.statement_balance
     OR NEW.ledger_balance <> OLD.ledger_balance OR NEW.uncleared <> OLD.uncleared THEN
    RAISE EXCEPTION 'Reconciliation % cannot be changed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bank_reconciliations_guard
  BEFORE UPDATE OR DELETE ON "bank_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_reconciliation();
