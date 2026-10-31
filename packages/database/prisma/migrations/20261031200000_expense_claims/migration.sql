-- M2 slice 4: employee expense claims. Generated DDL first, hand-written guards after.

-- CreateEnum
CREATE TYPE "ExpenseClaimStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'REJECTED', 'APPROVED', 'REIMBURSED', 'VOID');

-- AlterEnum
ALTER TYPE "AttachmentEntity" ADD VALUE 'EXPENSE_CLAIM';

-- AlterEnum
ALTER TYPE "JournalSource" ADD VALUE 'EXPENSE';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'EMPLOYEE';

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "claims_account_id" UUID;

-- CreateTable
CREATE TABLE "expense_claims" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "claimant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "ExpenseClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "net_total" DECIMAL(24,6) NOT NULL,
    "tax_total" DECIMAL(24,6) NOT NULL,
    "total" DECIMAL(24,6) NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "journal_entry_id" UUID,
    "posting_date" DATE,
    "reimbursement_journal_entry_id" UUID,
    "reimbursed_on" DATE,
    "reimbursed_by_id" UUID,
    "bank_account_id" UUID,
    "reimbursement_reference" TEXT,
    "void_journal_entry_id" UUID,
    "void_date" DATE,
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "expense_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_claim_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "account_id" UUID NOT NULL,
    "merchant" TEXT,
    "description" TEXT,
    "amount" DECIMAL(24,6) NOT NULL,
    "tax_rate_id" UUID,
    "tax_rate" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "net_amount" DECIMAL(24,6) NOT NULL,
    "tax_amount" DECIMAL(24,6) NOT NULL,

    CONSTRAINT "expense_claim_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expense_claims_journal_entry_id_key" ON "expense_claims"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_claims_reimbursement_journal_entry_id_key" ON "expense_claims"("reimbursement_journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_claims_void_journal_entry_id_key" ON "expense_claims"("void_journal_entry_id");

-- CreateIndex
CREATE INDEX "expense_claims_org_id_status_idx" ON "expense_claims"("org_id", "status");

-- CreateIndex
CREATE INDEX "expense_claims_org_id_claimant_id_idx" ON "expense_claims"("org_id", "claimant_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_claims_id_org_id_key" ON "expense_claims"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_claims_org_id_number_key" ON "expense_claims"("org_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "expense_claim_lines_claim_id_line_no_key" ON "expense_claim_lines"("claim_id", "line_no");

-- AddForeignKey
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_claim_id_org_id_fkey" FOREIGN KEY ("claim_id", "org_id") REFERENCES "expense_claims"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_account_id_org_id_fkey" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_tax_rate_id_org_id_fkey" FOREIGN KEY ("tax_rate_id", "org_id") REFERENCES "tax_rates"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------- hand-written

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_claims_account_fk" FOREIGN KEY ("claims_account_id", "id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT;

ALTER TABLE "expense_claims"
  ADD CONSTRAINT "expense_claims_claimant_fk" FOREIGN KEY ("claimant_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "expense_claims_journal_fk" FOREIGN KEY ("journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "expense_claims_reimbursement_journal_fk" FOREIGN KEY ("reimbursement_journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "expense_claims_void_journal_fk" FOREIGN KEY ("void_journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "expense_claims_bank_account_fk" FOREIGN KEY ("bank_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "expense_claims_amounts_chk" CHECK ("total" = "net_total" + "tax_total" AND "total" >= 0 AND "net_total" >= 0 AND "tax_total" >= 0),
  ADD CONSTRAINT "expense_claims_title_chk" CHECK (length(trim("title")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "expense_claims_state_chk" CHECK (
    ("status" IN ('APPROVED', 'REIMBURSED', 'VOID')) = ("journal_entry_id" IS NOT NULL AND "posting_date" IS NOT NULL AND "decided_by_id" IS NOT NULL)
    AND ("status" = 'REIMBURSED') = ("reimbursement_journal_entry_id" IS NOT NULL AND "reimbursed_on" IS NOT NULL AND "bank_account_id" IS NOT NULL)
    AND ("status" = 'VOID') = ("void_journal_entry_id" IS NOT NULL AND "void_reason" IS NOT NULL)
    AND ("status" = 'DRAFT' OR "submitted_at" IS NOT NULL)
    AND ("status" <> 'REJECTED' OR ("decided_by_id" IS NOT NULL AND "decision_note" IS NOT NULL))
  );

ALTER TABLE "expense_claim_lines"
  ADD CONSTRAINT "expense_claim_lines_amounts_chk" CHECK ("amount" > 0 AND "tax_amount" >= 0 AND "net_amount" >= 0 AND "amount" = "net_amount" + "tax_amount"),
  ADD CONSTRAINT "expense_claim_lines_rate_chk" CHECK ("tax_rate" >= 0 AND "tax_rate" <= 100);

-- The employee reimbursements account is a control account like receivables and payables.
CREATE OR REPLACE FUNCTION t2t_check_control_account() RETURNS trigger AS $$
DECLARE
  src "JournalSource";
  o record;
BEGIN
  SELECT source INTO src FROM journal_entries WHERE id = NEW.entry_id;
  IF src::text IN ('MANUAL', 'BANK') THEN
    SELECT ar_account_id, ap_account_id, claims_account_id INTO o FROM organizations WHERE id = NEW.org_id;
    IF NEW.account_id = o.ar_account_id OR NEW.account_id = o.ap_account_id THEN
      RAISE EXCEPTION 'Account % is a receivables/payables control account; Cannot post a manual journal to it', NEW.account_id
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.account_id = o.claims_account_id THEN
      RAISE EXCEPTION 'Account % holds amounts owed to employees; Cannot post a manual journal to it, use an expense claim', NEW.account_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Claim lifecycle. Content can change only while the claim is a draft or rejected;
-- the approver is never the claimant; submitted claims add up; history is never deleted.
CREATE OR REPLACE FUNCTION t2t_guard_expense_claim() RETURNS trigger AS $$
DECLARE
  line_total numeric;
  line_count int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Expense claim % cannot be deleted unless it is a draft', OLD.number USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.number <> OLD.number OR NEW.claimant_id <> OLD.claimant_id OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'Expense claim % cannot be moved or renumbered', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status NOT IN ('DRAFT', 'REJECTED')
     AND (NEW.title <> OLD.title OR NEW.total <> OLD.total OR NEW.net_total <> OLD.net_total OR NEW.tax_total <> OLD.tax_total) THEN
    RAISE EXCEPTION 'Expense claim % can only be edited as a draft', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED')
      OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('DRAFT', 'REJECTED', 'APPROVED'))
      OR (OLD.status = 'REJECTED' AND NEW.status IN ('DRAFT', 'SUBMITTED'))
      OR (OLD.status = 'APPROVED' AND NEW.status IN ('REIMBURSED', 'VOID'))
    ) THEN
      RAISE EXCEPTION 'Expense claim % cannot go from % to %', OLD.number, OLD.status, NEW.status USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status = 'SUBMITTED' THEN
      SELECT coalesce(sum(amount), 0), count(*) INTO line_total, line_count FROM expense_claim_lines WHERE claim_id = NEW.id;
      IF line_count = 0 OR line_total <> NEW.total THEN
        RAISE EXCEPTION 'Expense claim % does not add up to its lines', OLD.number USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF NEW.status = 'APPROVED' AND NEW.decided_by_id = NEW.claimant_id THEN
      RAISE EXCEPTION 'Expense claim % must be approved by someone other than the claimant', OLD.number USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.status IN ('APPROVED', 'REIMBURSED', 'VOID')
     AND (NEW.decided_by_id IS DISTINCT FROM OLD.decided_by_id OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
          OR NEW.reimbursement_journal_entry_id IS DISTINCT FROM OLD.reimbursement_journal_entry_id OR NEW.void_journal_entry_id IS DISTINCT FROM OLD.void_journal_entry_id) THEN
    RAISE EXCEPTION 'Expense claim % cannot be changed', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER expense_claims_guard
  BEFORE UPDATE OR DELETE ON "expense_claims"
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_expense_claim();

CREATE OR REPLACE FUNCTION t2t_guard_expense_claim_line() RETURNS trigger AS $$
DECLARE
  st "ExpenseClaimStatus";
  cid uuid;
BEGIN
  cid := CASE WHEN TG_OP = 'DELETE' THEN OLD.claim_id ELSE NEW.claim_id END;
  SELECT status INTO st FROM expense_claims WHERE id = cid;
  -- st is NULL when the parent draft itself is being deleted (cascade).
  IF st IS NOT NULL AND st NOT IN ('DRAFT', 'REJECTED') THEN
    RAISE EXCEPTION 'Lines of a % expense claim cannot be changed', lower(st::text) USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.claim_id <> OLD.claim_id THEN
    RAISE EXCEPTION 'Expense claim lines cannot move between claims' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER expense_claim_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "expense_claim_lines"
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_expense_claim_line();
