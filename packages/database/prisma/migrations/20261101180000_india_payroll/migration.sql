-- CreateEnum
CREATE TYPE "PayComponentKind" AS ENUM ('WAGES', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "PtCategory" AS ENUM ('GENERAL', 'WOMAN', 'EXEMPT');

-- CreateEnum
CREATE TYPE "PayRunStatus" AS ENUM ('DRAFT', 'POSTED', 'VOID');

-- CreateEnum
CREATE TYPE "PayrollLiability" AS ENUM ('NET_PAY', 'PF', 'ESI', 'PT', 'TDS');

-- AlterEnum
ALTER TYPE "JournalSource" ADD VALUE 'PAYROLL';

-- CreateTable
CREATE TABLE "payroll_settings" (
    "org_id" UUID NOT NULL,
    "pf_establishment_code" TEXT,
    "esi_employer_code" TEXT,
    "pt_registration" TEXT,
    "salary_expense_account_id" UUID NOT NULL,
    "employer_contribution_account_id" UUID NOT NULL,
    "net_pay_account_id" UUID NOT NULL,
    "pf_payable_account_id" UUID NOT NULL,
    "esi_payable_account_id" UUID NOT NULL,
    "pt_payable_account_id" UUID NOT NULL,
    "tds_payable_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payroll_settings_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "pan" CHAR(10),
    "date_of_joining" DATE NOT NULL,
    "date_of_leaving" DATE,
    "work_state_code" CHAR(2),
    "pt_category" "PtCategory" NOT NULL DEFAULT 'GENERAL',
    "pf_member" BOOLEAN NOT NULL DEFAULT true,
    "eps_member" BOOLEAN NOT NULL DEFAULT true,
    "pf_on_full_wages" BOOLEAN NOT NULL DEFAULT false,
    "uan" TEXT,
    "esi_number" TEXT,
    "prior_tax_year" TEXT,
    "prior_income" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "prior_tds" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structures" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_components" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "structure_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PayComponentKind" NOT NULL,
    "monthly_amount" DECIMAL(24,6) NOT NULL,

    CONSTRAINT "salary_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_runs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "period" CHAR(7) NOT NULL,
    "status" "PayRunStatus" NOT NULL DEFAULT 'DRAFT',
    "pay_date" DATE NOT NULL,
    "gross" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "net" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "employer_cost" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "journal_entry_id" UUID,
    "posted_at" TIMESTAMPTZ(6),
    "posted_by_id" UUID,
    "void_journal_entry_id" UUID,
    "void_date" DATE,
    "void_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pay_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "pay_run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "structure_id" UUID NOT NULL,
    "days_in_month" SMALLINT NOT NULL,
    "days_outside" DECIMAL(4,1) NOT NULL DEFAULT 0,
    "lop_days" DECIMAL(4,1) NOT NULL DEFAULT 0,
    "paid_days" DECIMAL(4,1) NOT NULL,
    "one_offs" JSONB NOT NULL DEFAULT '[]',
    "earnings" JSONB NOT NULL,
    "gross" DECIMAL(24,6) NOT NULL,
    "wages" DECIMAL(24,6) NOT NULL,
    "wages_added_back" DECIMAL(24,6) NOT NULL,
    "pf_wages" DECIMAL(24,6) NOT NULL,
    "pf_employee" DECIMAL(24,6) NOT NULL,
    "eps" DECIMAL(24,6) NOT NULL,
    "epf_employer" DECIMAL(24,6) NOT NULL,
    "edli" DECIMAL(24,6) NOT NULL,
    "pf_admin" DECIMAL(24,6) NOT NULL,
    "esi_covered" BOOLEAN NOT NULL,
    "esi_wages" DECIMAL(24,6) NOT NULL,
    "esi_employee" DECIMAL(24,6) NOT NULL,
    "esi_employer" DECIMAL(24,6) NOT NULL,
    "pt" DECIMAL(24,6) NOT NULL,
    "pt_note" TEXT NOT NULL,
    "tds" DECIMAL(24,6) NOT NULL,
    "tds_detail" JSONB NOT NULL,
    "deductions" DECIMAL(24,6) NOT NULL,
    "net" DECIMAL(24,6) NOT NULL,
    "employer_cost" DECIMAL(24,6) NOT NULL,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_remittances" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "pay_run_id" UUID NOT NULL,
    "liability" "PayrollLiability" NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'POSTED',
    "journal_entry_id" UUID NOT NULL,
    "void_journal_entry_id" UUID,
    "void_date" DATE,
    "void_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_remittances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employees_org_id_code_key" ON "employees"("org_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "employees_id_org_id_key" ON "employees"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structures_employee_id_effective_from_key" ON "salary_structures"("employee_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structures_id_org_id_key" ON "salary_structures"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_components_structure_id_code_key" ON "salary_components"("structure_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "pay_runs_journal_entry_id_key" ON "pay_runs"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "pay_runs_void_journal_entry_id_key" ON "pay_runs"("void_journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "pay_runs_org_id_number_key" ON "pay_runs"("org_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "pay_runs_id_org_id_key" ON "pay_runs"("id", "org_id");

-- CreateIndex
CREATE INDEX "payslips_org_id_employee_id_idx" ON "payslips"("org_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_pay_run_id_employee_id_key" ON "payslips"("pay_run_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_remittances_journal_entry_id_key" ON "payroll_remittances"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_remittances_void_journal_entry_id_key" ON "payroll_remittances"("void_journal_entry_id");

-- CreateIndex
CREATE INDEX "payroll_remittances_pay_run_id_idx" ON "payroll_remittances"("pay_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_remittances_org_id_number_key" ON "payroll_remittances"("org_id", "number");

-- AddForeignKey
ALTER TABLE "payroll_settings" ADD CONSTRAINT "payroll_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_employee_id_org_id_fkey" FOREIGN KEY ("employee_id", "org_id") REFERENCES "employees"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_components" ADD CONSTRAINT "salary_components_structure_id_org_id_fkey" FOREIGN KEY ("structure_id", "org_id") REFERENCES "salary_structures"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_pay_run_id_org_id_fkey" FOREIGN KEY ("pay_run_id", "org_id") REFERENCES "pay_runs"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_id_org_id_fkey" FOREIGN KEY ("employee_id", "org_id") REFERENCES "employees"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_structure_id_org_id_fkey" FOREIGN KEY ("structure_id", "org_id") REFERENCES "salary_structures"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_remittances" ADD CONSTRAINT "payroll_remittances_pay_run_id_org_id_fkey" FOREIGN KEY ("pay_run_id", "org_id") REFERENCES "pay_runs"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- hand-written: integrity, guards, RLS

ALTER TABLE "payroll_settings"
  ADD CONSTRAINT "payroll_settings_salary_fk" FOREIGN KEY ("salary_expense_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payroll_settings_employer_fk" FOREIGN KEY ("employer_contribution_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payroll_settings_net_fk" FOREIGN KEY ("net_pay_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payroll_settings_pf_fk" FOREIGN KEY ("pf_payable_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payroll_settings_esi_fk" FOREIGN KEY ("esi_payable_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payroll_settings_pt_fk" FOREIGN KEY ("pt_payable_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payroll_settings_tds_fk" FOREIGN KEY ("tds_payable_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT;

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_code_chk" CHECK (length(btrim("code")) > 0 AND length(btrim("name")) > 0),
  ADD CONSTRAINT "employees_pan_chk" CHECK ("pan" IS NULL OR "pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  ADD CONSTRAINT "employees_dates_chk" CHECK ("date_of_leaving" IS NULL OR "date_of_leaving" >= "date_of_joining"),
  ADD CONSTRAINT "employees_state_chk" CHECK ("work_state_code" IS NULL OR "work_state_code" ~ '^[0-9]{2}$'),
  ADD CONSTRAINT "employees_prior_chk" CHECK ("prior_income" >= 0 AND "prior_tds" >= 0 AND ("prior_tax_year" IS NULL OR "prior_tax_year" ~ '^[0-9]{4}-[0-9]{2}$') AND (("prior_income" = 0 AND "prior_tds" = 0) OR "prior_tax_year" IS NOT NULL)),
  ADD CONSTRAINT "employees_eps_chk" CHECK ("pf_member" OR (NOT "eps_member" AND NOT "pf_on_full_wages"));

ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_month_chk" CHECK (extract(day FROM "effective_from") = 1);
ALTER TABLE "salary_components"
  ADD CONSTRAINT "salary_components_amount_chk" CHECK ("monthly_amount" >= 0 AND "position" >= 0 AND length(btrim("code")) > 0 AND length(btrim("name")) > 0);

-- A salary structure is never changed: a revision is a new structure. Components can be added or removed only while no payslip uses the structure.
CREATE OR REPLACE FUNCTION t2t_guard_salary_structure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Salary structure % cannot change; add a revision from a later month', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER salary_structures_guard BEFORE UPDATE ON "salary_structures" FOR EACH ROW EXECUTE FUNCTION t2t_guard_salary_structure();

CREATE OR REPLACE FUNCTION t2t_guard_salary_component() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid := COALESCE(NEW.structure_id, OLD.structure_id);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Salary components cannot change; add a revision from a later month' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM payslips p WHERE p.structure_id = sid) THEN
    RAISE EXCEPTION 'Salary structure % is used by a payslip; add a revision from a later month', sid USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER salary_components_guard BEFORE INSERT OR UPDATE OR DELETE ON "salary_components" FOR EACH ROW EXECUTE FUNCTION t2t_guard_salary_component();

ALTER TABLE "pay_runs"
  ADD CONSTRAINT "pay_runs_period_chk" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT "pay_runs_amounts_chk" CHECK ("gross" >= 0 AND "deductions" >= 0 AND "net" >= 0 AND "employer_cost" >= 0 AND "net" = "gross" - "deductions"),
  ADD CONSTRAINT "pay_runs_status_chk" CHECK (
    ("status" = 'DRAFT' AND "journal_entry_id" IS NULL AND "void_journal_entry_id" IS NULL)
    OR ("status" = 'POSTED' AND "journal_entry_id" IS NOT NULL AND "posted_at" IS NOT NULL AND "void_journal_entry_id" IS NULL)
    OR ("status" = 'VOID' AND "journal_entry_id" IS NOT NULL AND "void_journal_entry_id" IS NOT NULL AND "void_date" IS NOT NULL AND "void_reason" IS NOT NULL)),
  ADD CONSTRAINT "pay_runs_journal_fk" FOREIGN KEY ("journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "pay_runs_void_journal_fk" FOREIGN KEY ("void_journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT;
-- One live pay run per month.
CREATE UNIQUE INDEX "pay_runs_period_live_uniq" ON "pay_runs" ("org_id", "period") WHERE "status" <> 'VOID';

CREATE OR REPLACE FUNCTION t2t_guard_pay_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Pay run % is posted; void it instead', OLD.number USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.org_id, NEW.number, NEW.period) IS DISTINCT FROM (OLD.org_id, OLD.number, OLD.period) THEN
    RAISE EXCEPTION 'A pay run''s number and month never change' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'DRAFT' THEN
    IF NEW.status = 'VOID' THEN
      RAISE EXCEPTION 'A draft pay run is deleted, not voided' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'VOID' OR NEW.status <> 'VOID'
     OR (NEW.pay_date, NEW.gross, NEW.deductions, NEW.net, NEW.employer_cost, NEW.journal_entry_id, NEW.posted_at, NEW.posted_by_id)
        IS DISTINCT FROM (OLD.pay_date, OLD.gross, OLD.deductions, OLD.net, OLD.employer_cost, OLD.journal_entry_id, OLD.posted_at, OLD.posted_by_id) THEN
    RAISE EXCEPTION 'Posted pay run % is immutable; void it instead', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM payroll_remittances r WHERE r.pay_run_id = OLD.id AND r.status = 'POSTED') THEN
    RAISE EXCEPTION 'Pay run % has payments recorded against it; void them first', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pay_runs_guard BEFORE UPDATE OR DELETE ON "pay_runs" FOR EACH ROW EXECUTE FUNCTION t2t_guard_pay_run();

ALTER TABLE "payslips"
  ADD CONSTRAINT "payslips_days_chk" CHECK ("days_in_month" BETWEEN 28 AND 31 AND "days_outside" >= 0 AND "lop_days" >= 0 AND "paid_days" >= 0 AND "paid_days" = "days_in_month" - "days_outside" - "lop_days"),
  ADD CONSTRAINT "payslips_amounts_chk" CHECK (
    "gross" >= 0 AND "wages" >= 0 AND "wages_added_back" >= 0 AND "pf_wages" >= 0 AND "pf_employee" >= 0 AND "eps" >= 0 AND "epf_employer" >= 0
    AND "edli" >= 0 AND "pf_admin" >= 0 AND "esi_wages" >= 0 AND "esi_employee" >= 0 AND "esi_employer" >= 0 AND "pt" >= 0 AND "tds" >= 0
    AND "deductions" = "pf_employee" + "esi_employee" + "pt" + "tds"
    AND "net" = "gross" - "deductions" AND "net" >= 0
    AND "employer_cost" = "gross" + "eps" + "epf_employer" + "edli" + "pf_admin" + "esi_employer"),
  ADD CONSTRAINT "payslips_esi_chk" CHECK ("esi_covered" OR ("esi_wages" = 0 AND "esi_employee" = 0 AND "esi_employer" = 0));

-- Payslips change only while their pay run is a draft.
CREATE OR REPLACE FUNCTION t2t_guard_payslip() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid := COALESCE(NEW.pay_run_id, OLD.pay_run_id);
BEGIN
  IF EXISTS (SELECT 1 FROM pay_runs r WHERE r.id = rid AND r.status <> 'DRAFT') THEN
    RAISE EXCEPTION 'Payslips of a posted pay run cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.pay_run_id, NEW.employee_id, NEW.org_id) IS DISTINCT FROM (OLD.pay_run_id, OLD.employee_id, OLD.org_id) THEN
    RAISE EXCEPTION 'A payslip cannot move to another pay run or employee' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER payslips_guard BEFORE INSERT OR UPDATE OR DELETE ON "payslips" FOR EACH ROW EXECUTE FUNCTION t2t_guard_payslip();

ALTER TABLE "payroll_remittances"
  ADD CONSTRAINT "payroll_remittances_amount_chk" CHECK ("amount" > 0 AND length(btrim("reference")) > 0),
  ADD CONSTRAINT "payroll_remittances_void_chk" CHECK (("status" = 'POSTED' AND "void_journal_entry_id" IS NULL) OR ("status" = 'VOID' AND "void_journal_entry_id" IS NOT NULL AND "void_date" IS NOT NULL AND "void_reason" IS NOT NULL)),
  ADD CONSTRAINT "payroll_remittances_journal_fk" FOREIGN KEY ("journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payroll_remittances_void_journal_fk" FOREIGN KEY ("void_journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payroll_remittances_bank_fk" FOREIGN KEY ("bank_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT;
-- Each liability of a pay run is paid once (until that payment is voided).
CREATE UNIQUE INDEX "payroll_remittances_live_uniq" ON "payroll_remittances" ("pay_run_id", "liability") WHERE "status" = 'POSTED';

CREATE OR REPLACE FUNCTION t2t_guard_payroll_remittance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payroll payment % cannot be deleted; void it instead', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM pay_runs r WHERE r.id = NEW.pay_run_id AND r.status = 'POSTED') THEN
      RAISE EXCEPTION 'Payments can be recorded only against a posted pay run' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'VOID' OR NEW.status <> 'VOID'
     OR (NEW.org_id, NEW.pay_run_id, NEW.liability, NEW.number, NEW.date, NEW.bank_account_id, NEW.reference, NEW.amount, NEW.journal_entry_id)
        IS DISTINCT FROM (OLD.org_id, OLD.pay_run_id, OLD.liability, OLD.number, OLD.date, OLD.bank_account_id, OLD.reference, OLD.amount, OLD.journal_entry_id) THEN
    RAISE EXCEPTION 'Payroll payment % is immutable; void it instead', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_remittances_guard BEFORE INSERT OR UPDATE OR DELETE ON "payroll_remittances" FOR EACH ROW EXECUTE FUNCTION t2t_guard_payroll_remittance();

-- Row-level security, as for every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_settings', 'employees', 'salary_structures', 'salary_components', 'pay_runs', 'payslips', 'payroll_remittances'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
