-- Loans: borrowings repaid in monthly installments, with their repayments, prepayments and rate changes.
CREATE TYPE "LoanMethod" AS ENUM ('EMI', 'EQUAL_PRINCIPAL');
CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'CLOSED');
CREATE TYPE "LoanEventKind" AS ENUM ('REPAYMENT', 'PREPAYMENT', 'RATE_CHANGE');
CREATE TYPE "LoanEventStatus" AS ENUM ('POSTED', 'REVERSED');
ALTER TYPE "JournalSource" ADD VALUE 'LOAN';

CREATE TABLE "loans" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "lender" VARCHAR(200),
    "account_number" VARCHAR(60),
    "method" "LoanMethod" NOT NULL,
    "principal" DECIMAL(24,6) NOT NULL,
    "original_rate" DECIMAL(9,4) NOT NULL,
    "months" INTEGER NOT NULL,
    "disbursement_date" DATE NOT NULL,
    "first_due_date" DATE NOT NULL,
    "liability_account_id" UUID NOT NULL,
    "interest_account_id" UUID NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "disbursement_entry_id" UUID,
    "annual_rate" DECIMAL(9,4) NOT NULL,
    "installment" DECIMAL(24,6) NOT NULL,
    "last_no" INTEGER,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "closed_on" DATE,
    "notes" VARCHAR(1000),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_events" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "LoanEventKind" NOT NULL,
    "date" DATE NOT NULL,
    "installment_no" INTEGER,
    "principal" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "interest" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "charges" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "bank_account_id" UUID,
    "charges_account_id" UUID,
    "entry_id" UUID,
    "mode" VARCHAR(30),
    "balance_before" DECIMAL(24,6) NOT NULL,
    "balance_after" DECIMAL(24,6) NOT NULL,
    "rate_before" DECIMAL(9,4) NOT NULL,
    "rate_after" DECIMAL(9,4) NOT NULL,
    "installment_before" DECIMAL(24,6) NOT NULL,
    "installment_after" DECIMAL(24,6) NOT NULL,
    "last_no_before" INTEGER,
    "last_no_after" INTEGER,
    "note" VARCHAR(500),
    "status" "LoanEventStatus" NOT NULL DEFAULT 'POSTED',
    "reversal_entry_id" UUID,
    "reversed_by_id" UUID,
    "reversed_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loans_org_id_status_idx" ON "loans"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "loans_org_id_number_key" ON "loans"("org_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "loans_id_org_id_key" ON "loans"("id", "org_id");

-- CreateIndex
CREATE INDEX "loan_events_org_id_kind_date_idx" ON "loan_events"("org_id", "kind", "date");

-- CreateIndex
CREATE UNIQUE INDEX "loan_events_loan_id_seq_key" ON "loan_events"("loan_id", "seq");

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_events" ADD CONSTRAINT "loan_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_events" ADD CONSTRAINT "loan_events_loan_id_org_id_fkey" FOREIGN KEY ("loan_id", "org_id") REFERENCES "loans"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "loans" ADD CONSTRAINT "loans_liability_account_fk" FOREIGN KEY ("liability_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loans" ADD CONSTRAINT "loans_interest_account_fk" FOREIGN KEY ("interest_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loans" ADD CONSTRAINT "loans_bank_account_fk" FOREIGN KEY ("bank_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loans" ADD CONSTRAINT "loans_disbursement_entry_fk" FOREIGN KEY ("disbursement_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loan_events" ADD CONSTRAINT "loan_events_bank_account_fk" FOREIGN KEY ("bank_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loan_events" ADD CONSTRAINT "loan_events_charges_account_fk" FOREIGN KEY ("charges_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loan_events" ADD CONSTRAINT "loan_events_entry_fk" FOREIGN KEY ("entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loan_events" ADD CONSTRAINT "loan_events_reversal_entry_fk" FOREIGN KEY ("reversal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "loans" ADD CONSTRAINT "loans_chk" CHECK (
  number > 0 AND length(btrim(name)) > 0 AND principal > 0 AND months BETWEEN 1 AND 480
  AND original_rate >= 0 AND original_rate < 100 AND annual_rate >= 0 AND annual_rate < 100 AND installment > 0
  AND first_due_date > disbursement_date AND (last_no IS NULL OR last_no > 0)
  AND liability_account_id <> interest_account_id AND liability_account_id <> bank_account_id
  AND ((status = 'ACTIVE' AND closed_on IS NULL) OR (status = 'CLOSED' AND closed_on IS NOT NULL))
);
ALTER TABLE "loan_events" ADD CONSTRAINT "loan_events_chk" CHECK (
  seq > 0 AND principal >= 0 AND interest >= 0 AND charges >= 0 AND balance_before >= 0 AND balance_after >= 0
  AND balance_after = balance_before - principal AND installment_after > 0 AND rate_after >= 0 AND rate_after < 100
  AND ((kind = 'REPAYMENT' AND installment_no > 0 AND principal + interest > 0 AND entry_id IS NOT NULL AND bank_account_id IS NOT NULL AND charges = 0)
    OR (kind = 'PREPAYMENT' AND installment_no IS NULL AND principal > 0 AND interest = 0 AND entry_id IS NOT NULL AND bank_account_id IS NOT NULL
        AND (charges = 0 OR charges_account_id IS NOT NULL) AND mode IN ('REDUCE_TENURE', 'REDUCE_INSTALLMENT'))
    OR (kind = 'RATE_CHANGE' AND installment_no IS NULL AND principal = 0 AND interest = 0 AND charges = 0 AND entry_id IS NULL AND mode IN ('KEEP_INSTALLMENT', 'KEEP_TENURE')))
  AND ((status = 'POSTED' AND reversed_by_id IS NULL AND reversed_at IS NULL AND reversal_entry_id IS NULL)
    OR (status = 'REVERSED' AND reversed_by_id IS NOT NULL AND reversed_at IS NOT NULL AND (reversal_entry_id IS NULL) = (entry_id IS NULL)))
);

-- Loans are never deleted, and what was agreed when the loan was taken does not change.
CREATE FUNCTION t2t_guard_loan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Loans are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.number <> OLD.number OR NEW.method <> OLD.method OR NEW.principal <> OLD.principal
     OR NEW.original_rate <> OLD.original_rate OR NEW.months <> OLD.months OR NEW.disbursement_date <> OLD.disbursement_date
     OR NEW.first_due_date <> OLD.first_due_date OR NEW.liability_account_id <> OLD.liability_account_id
     OR NEW.interest_account_id <> OLD.interest_account_id OR NEW.disbursement_entry_id IS DISTINCT FROM OLD.disbursement_entry_id
     OR NEW.created_by_id <> OLD.created_by_id THEN
    RAISE EXCEPTION 'A loan keeps its amount, original rate, term, dates, accounts and opening entry' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER loans_guard BEFORE UPDATE OR DELETE ON "loans" FOR EACH ROW EXECUTE FUNCTION t2t_guard_loan();

-- Loan events are never deleted; a posted event changes only to record its reversal.
CREATE FUNCTION t2t_guard_loan_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Loan repayments, prepayments and rate changes are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'REVERSED' OR NEW.status <> 'REVERSED' OR NEW.org_id <> OLD.org_id OR NEW.loan_id <> OLD.loan_id OR NEW.seq <> OLD.seq
     OR NEW.kind <> OLD.kind OR NEW.date <> OLD.date OR NEW.principal <> OLD.principal OR NEW.interest <> OLD.interest OR NEW.charges <> OLD.charges
     OR NEW.entry_id IS DISTINCT FROM OLD.entry_id OR NEW.balance_before <> OLD.balance_before OR NEW.balance_after <> OLD.balance_after
     OR NEW.rate_before <> OLD.rate_before OR NEW.rate_after <> OLD.rate_after OR NEW.installment_before <> OLD.installment_before
     OR NEW.installment_after <> OLD.installment_after OR NEW.created_by_id <> OLD.created_by_id THEN
    RAISE EXCEPTION 'A loan event changes only to record its reversal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER loan_events_guard BEFORE UPDATE OR DELETE ON "loan_events" FOR EACH ROW EXECUTE FUNCTION t2t_guard_loan_event();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['loans', 'loan_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
