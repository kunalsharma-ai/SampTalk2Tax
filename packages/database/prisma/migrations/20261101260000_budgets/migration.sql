-- CreateEnum
CREATE TYPE "BudgetStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "budgets" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "basis" TEXT NOT NULL,
    "source_budget_id" UUID,
    "change_percent" DECIMAL(7,2),
    "status" "BudgetStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_by_id" UUID,
    "submitted_at" TIMESTAMPTZ(6),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "superseded_at" TIMESTAMPTZ(6),
    "returned_by_id" UUID,
    "returned_at" TIMESTAMPTZ(6),
    "return_reason" TEXT,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "budget_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "period_no" SMALLINT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "budgets_org_id_fiscal_year_version_key" ON "budgets"("org_id", "fiscal_year", "version");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_id_org_id_key" ON "budgets"("id", "org_id");

-- CreateIndex
CREATE INDEX "budget_lines_account_id_idx" ON "budget_lines"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_lines_budget_id_account_id_period_no_key" ON "budget_lines"("budget_id", "account_id", "period_no");

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budget_id_org_id_fkey" FOREIGN KEY ("budget_id", "org_id") REFERENCES "budgets"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_account_id_org_id_fkey" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- hand-written

ALTER TABLE "budgets" ADD CONSTRAINT "budgets_source_fkey" FOREIGN KEY ("source_budget_id", "org_id") REFERENCES "budgets"("id", "org_id") ON DELETE RESTRICT;

ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_chk" CHECK (
    "version" >= 1 AND "fiscal_year" BETWEEN 2000 AND 2200
    AND length(btrim("name")) BETWEEN 1 AND 100 AND ("note" IS NULL OR length("note") <= 1000)
    AND ("basis" = 'EMPTY' AND "source_budget_id" IS NULL AND "change_percent" IS NULL
         OR "basis" = 'COPY' AND "source_budget_id" IS NOT NULL AND "change_percent" IS NULL
         OR "basis" = 'PRIOR_ACTUALS' AND "source_budget_id" IS NULL AND "change_percent" IS NOT NULL AND "change_percent" BETWEEN -100 AND 1000)),
  ADD CONSTRAINT "budgets_status_chk" CHECK (
    ("status" = 'DRAFT' AND "submitted_at" IS NULL AND "submitted_by_id" IS NULL AND "approved_at" IS NULL AND "approved_by_id" IS NULL AND "superseded_at" IS NULL)
    OR ("status" = 'SUBMITTED' AND "submitted_at" IS NOT NULL AND "submitted_by_id" IS NOT NULL AND "approved_at" IS NULL AND "approved_by_id" IS NULL AND "superseded_at" IS NULL)
    OR ("status" IN ('APPROVED', 'SUPERSEDED') AND "submitted_at" IS NOT NULL AND "submitted_by_id" IS NOT NULL
        AND "approved_at" IS NOT NULL AND "approved_by_id" IS NOT NULL AND "approved_at" >= "submitted_at"
        AND ("status" = 'APPROVED') = ("superseded_at" IS NULL))),
  -- Separation of duties: the person who submits a budget cannot approve it.
  ADD CONSTRAINT "budgets_approver_chk" CHECK ("approved_by_id" IS NULL OR "approved_by_id" <> "submitted_by_id"),
  ADD CONSTRAINT "budgets_return_chk" CHECK (("returned_at" IS NULL) = ("returned_by_id" IS NULL) AND ("returned_at" IS NULL) = ("return_reason" IS NULL));
-- One approved budget per fiscal year.
CREATE UNIQUE INDEX "budgets_one_approved_uniq" ON "budgets" ("org_id", "fiscal_year") WHERE "status" = 'APPROVED';

ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_chk" CHECK ("period_no" BETWEEN 1 AND 12);

-- Status moves: DRAFT -> SUBMITTED -> APPROVED -> SUPERSEDED, and SUBMITTED -> DRAFT (withdrawn or returned).
-- Only drafts are renamed or deleted; what a version is (year, number, basis, creator) never changes.
CREATE OR REPLACE FUNCTION t2t_guard_budget() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only draft budgets can be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'A budget starts as a draft' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.fiscal_year, NEW.version, NEW.basis, NEW.source_budget_id, NEW.change_percent, NEW.created_by_id, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.fiscal_year, OLD.version, OLD.basis, OLD.source_budget_id, OLD.change_percent, OLD.created_by_id, OLD.created_at) THEN
    RAISE EXCEPTION 'A budget version''s year, number and origin never change' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.name, NEW.note) IS DISTINCT FROM (OLD.name, OLD.note) THEN
    RAISE EXCEPTION 'Only a draft budget can be renamed' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED')
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('DRAFT', 'APPROVED'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'A budget cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('APPROVED', 'SUPERSEDED')
     AND (NEW.submitted_at, NEW.submitted_by_id, NEW.approved_at, NEW.approved_by_id, NEW.returned_at, NEW.returned_by_id, NEW.return_reason)
         IS DISTINCT FROM (OLD.submitted_at, OLD.submitted_by_id, OLD.approved_at, OLD.approved_by_id, OLD.returned_at, OLD.returned_by_id, OLD.return_reason) THEN
    RAISE EXCEPTION 'An approved budget''s history never changes' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER budgets_guard BEFORE INSERT OR UPDATE OR DELETE ON "budgets" FOR EACH ROW EXECUTE FUNCTION t2t_guard_budget();

-- Lines change only while their budget is a draft, and only for postable revenue or expense accounts.
CREATE OR REPLACE FUNCTION t2t_guard_budget_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st "BudgetStatus"; acc record;
BEGIN
  SELECT status INTO st FROM budgets WHERE id = COALESCE(NEW.budget_id, OLD.budget_id);
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Budget lines change only while the budget is a draft' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.budget_id, NEW.org_id) IS DISTINCT FROM (OLD.budget_id, OLD.org_id) THEN
    RAISE EXCEPTION 'A budget line stays in its budget' USING ERRCODE = 'P0001';
  END IF;
  SELECT type::text AS type, is_postable INTO acc FROM accounts WHERE id = NEW.account_id;
  IF acc.type NOT IN ('REVENUE', 'EXPENSE') OR NOT acc.is_postable THEN
    RAISE EXCEPTION 'Budgets hold postable revenue and expense accounts only' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER budget_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "budget_lines" FOR EACH ROW EXECUTE FUNCTION t2t_guard_budget_line();

-- Row-level security, as for every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['budgets', 'budget_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
