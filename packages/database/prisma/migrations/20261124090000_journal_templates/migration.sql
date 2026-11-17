-- GL-007 / GL-012: journal templates, optionally posting themselves on a schedule.
CREATE TYPE "JournalTemplateStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "RecurringPostMode" AS ENUM ('DRAFT', 'POST');
CREATE TYPE "RecurringScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ENDED');

CREATE TABLE "journal_templates" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "journal_type" VARCHAR(20) NOT NULL DEFAULT 'STANDARD',
    "memo" VARCHAR(1000),
    "reference" VARCHAR(100),
    "status" "JournalTemplateStatus" NOT NULL DEFAULT 'ACTIVE',
    "frequency" "ContractFrequency",
    "start_date" DATE,
    "end_date" DATE,
    "month_end" BOOLEAN NOT NULL DEFAULT false,
    "post_mode" "RecurringPostMode" NOT NULL DEFAULT 'DRAFT',
    "schedule_status" "RecurringScheduleStatus",
    "next_run_no" INTEGER NOT NULL DEFAULT 1,
    "last_error" VARCHAR(1000),
    "last_error_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "journal_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "journal_template_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "account_id" UUID NOT NULL,
    "debit" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "credit" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "currency" CHAR(3),
    "description" VARCHAR(500),
    "department_id" UUID,
    "project_id" UUID,
    CONSTRAINT "journal_template_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "journal_template_runs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "run_no" INTEGER,
    "run_date" DATE NOT NULL,
    "journal_entry_id" UUID,
    "entry_number" INTEGER,
    "posted" BOOLEAN NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "journal_template_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "journal_templates_org_id_number_key" ON "journal_templates"("org_id", "number");
CREATE UNIQUE INDEX "journal_templates_id_org_id_key" ON "journal_templates"("id", "org_id");
CREATE INDEX "journal_templates_org_id_status_idx" ON "journal_templates"("org_id", "status");
CREATE INDEX "journal_templates_schedule_status_idx" ON "journal_templates"("schedule_status");
CREATE UNIQUE INDEX "journal_template_lines_template_id_line_no_key" ON "journal_template_lines"("template_id", "line_no");
CREATE UNIQUE INDEX "journal_template_runs_template_id_run_no_key" ON "journal_template_runs"("template_id", "run_no");
CREATE INDEX "journal_template_runs_template_id_created_at_idx" ON "journal_template_runs"("template_id", "created_at");
CREATE INDEX "journal_template_runs_journal_entry_id_idx" ON "journal_template_runs"("journal_entry_id");

ALTER TABLE "journal_templates" ADD CONSTRAINT "journal_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_templates" ADD CONSTRAINT "journal_templates_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_template_lines" ADD CONSTRAINT "journal_template_lines_template_id_fkey" FOREIGN KEY ("template_id", "org_id") REFERENCES "journal_templates"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_template_lines" ADD CONSTRAINT "journal_template_lines_account_fk" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_template_lines" ADD CONSTRAINT "journal_template_lines_department_fk" FOREIGN KEY ("department_id", "org_id") REFERENCES "dimension_values"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_template_lines" ADD CONSTRAINT "journal_template_lines_project_fk" FOREIGN KEY ("project_id", "org_id") REFERENCES "dimension_values"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A template with runs is archived, not deleted.
ALTER TABLE "journal_template_runs" ADD CONSTRAINT "journal_template_runs_template_id_fkey" FOREIGN KEY ("template_id", "org_id") REFERENCES "journal_templates"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Deleting a draft journal a run made leaves the run with no journal (and its number kept).
ALTER TABLE "journal_template_runs" ADD CONSTRAINT "journal_template_runs_entry_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "journal_template_runs" ADD CONSTRAINT "journal_template_runs_actor_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_templates" ADD CONSTRAINT "journal_templates_chk" CHECK (
  number > 0 AND next_run_no > 0
  AND journal_type IN ('STANDARD', 'ADJUSTING')
  -- A schedule has a frequency, a start and a status; a plain template has none of them.
  AND ((frequency IS NULL) = (start_date IS NULL) AND (frequency IS NULL) = (schedule_status IS NULL))
  AND (end_date IS NULL OR (start_date IS NOT NULL AND end_date >= start_date))
  AND (frequency IS NOT NULL OR (NOT month_end AND next_run_no = 1))
  AND (status = 'ACTIVE' OR schedule_status IS NULL OR schedule_status <> 'ACTIVE')
);
ALTER TABLE "journal_template_lines" ADD CONSTRAINT "journal_template_lines_chk" CHECK (
  line_no > 0 AND debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0)
  AND (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);
ALTER TABLE "journal_template_runs" ADD CONSTRAINT "journal_template_runs_chk" CHECK (run_no IS NULL OR run_no > 0);

-- The schedule cannot be rewound or reshaped once it has run: runs already made stay numbered.
CREATE FUNCTION t2t_guard_journal_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id <> OLD.org_id OR NEW.number <> OLD.number OR NEW.created_by_id <> OLD.created_by_id THEN
    RAISE EXCEPTION 'A template keeps its number and creator' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.next_run_no < OLD.next_run_no THEN
    RAISE EXCEPTION 'Runs already made are not undone' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.next_run_no > 1 AND (NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.frequency IS DISTINCT FROM OLD.frequency OR NEW.month_end <> OLD.month_end) THEN
    RAISE EXCEPTION 'A schedule that has run keeps its start date, frequency and run day' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_templates_guard BEFORE UPDATE ON "journal_templates" FOR EACH ROW EXECUTE FUNCTION t2t_guard_journal_template();

-- The run history is append-only; the only change is losing the link to a deleted draft journal.
CREATE FUNCTION t2t_guard_journal_template_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.journal_entry_id IS NULL AND OLD.journal_entry_id IS NOT NULL
     AND (to_jsonb(NEW) - 'journal_entry_id') = (to_jsonb(OLD) - 'journal_entry_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The run history of a template is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER journal_template_runs_guard BEFORE UPDATE OR DELETE ON "journal_template_runs" FOR EACH ROW EXECUTE FUNCTION t2t_guard_journal_template_run();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['journal_templates', 'journal_template_lines', 'journal_template_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
