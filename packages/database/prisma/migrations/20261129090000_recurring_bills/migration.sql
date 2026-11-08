-- AP-005 recurring bills: a vendor bill made again on a schedule, as a draft or posted.
CREATE TABLE "recurring_bills" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "contact_id" UUID NOT NULL,
    "reference" VARCHAR(100),
    "memo" VARCHAR(1000),
    "place_of_supply" CHAR(2),
    "reverse_charge" BOOLEAN NOT NULL DEFAULT false,
    "withholding_section_id" UUID,
    "due_days" INTEGER,
    "frequency" "ContractFrequency" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "month_end" BOOLEAN NOT NULL DEFAULT false,
    "post_mode" "RecurringPostMode" NOT NULL DEFAULT 'DRAFT',
    "status" "RecurringScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "next_run_no" INTEGER NOT NULL DEFAULT 1,
    "last_error" VARCHAR(1000),
    "last_error_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "recurring_bills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recurring_bill_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "recurring_bill_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "account_id" UUID NOT NULL,
    "description" VARCHAR(500),
    "quantity" DECIMAL(24,6) NOT NULL,
    "unit_price" DECIMAL(24,6) NOT NULL,
    "tax_rate_id" UUID,
    "hsn_code" VARCHAR(8),
    "department_id" UUID,
    "project_id" UUID,
    CONSTRAINT "recurring_bill_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recurring_bill_runs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "recurring_bill_id" UUID NOT NULL,
    "run_no" INTEGER NOT NULL,
    "run_date" DATE NOT NULL,
    "document_id" UUID,
    "posted" BOOLEAN NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recurring_bill_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recurring_bills_org_id_number_key" ON "recurring_bills"("org_id", "number");
CREATE UNIQUE INDEX "recurring_bills_id_org_id_key" ON "recurring_bills"("id", "org_id");
CREATE INDEX "recurring_bills_status_idx" ON "recurring_bills"("status");
CREATE UNIQUE INDEX "recurring_bill_lines_recurring_bill_id_line_no_key" ON "recurring_bill_lines"("recurring_bill_id", "line_no");
CREATE UNIQUE INDEX "recurring_bill_runs_recurring_bill_id_run_no_key" ON "recurring_bill_runs"("recurring_bill_id", "run_no");
CREATE INDEX "recurring_bill_runs_document_id_idx" ON "recurring_bill_runs"("document_id");

ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_withholding_fk" FOREIGN KEY ("withholding_section_id", "org_id") REFERENCES "withholding_sections"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_bill_lines" ADD CONSTRAINT "recurring_bill_lines_recurring_bill_id_fkey" FOREIGN KEY ("recurring_bill_id", "org_id") REFERENCES "recurring_bills"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recurring_bill_lines" ADD CONSTRAINT "recurring_bill_lines_account_fk" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_bill_lines" ADD CONSTRAINT "recurring_bill_lines_tax_rate_fk" FOREIGN KEY ("tax_rate_id", "org_id") REFERENCES "tax_rates"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_bill_lines" ADD CONSTRAINT "recurring_bill_lines_department_fk" FOREIGN KEY ("department_id", "org_id") REFERENCES "dimension_values"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_bill_lines" ADD CONSTRAINT "recurring_bill_lines_project_fk" FOREIGN KEY ("project_id", "org_id") REFERENCES "dimension_values"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A recurring bill that has run is ended, not deleted.
ALTER TABLE "recurring_bill_runs" ADD CONSTRAINT "recurring_bill_runs_recurring_bill_id_fkey" FOREIGN KEY ("recurring_bill_id", "org_id") REFERENCES "recurring_bills"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Deleting a draft bill a run made leaves the run with no bill (and its number kept).
ALTER TABLE "recurring_bill_runs" ADD CONSTRAINT "recurring_bill_runs_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE SET NULL ("document_id") ON UPDATE CASCADE;
ALTER TABLE "recurring_bill_runs" ADD CONSTRAINT "recurring_bill_runs_actor_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_chk" CHECK (
  number > 0 AND next_run_no > 0
  AND (end_date IS NULL OR end_date >= start_date)
  AND (due_days IS NULL OR due_days BETWEEN 0 AND 365)
  AND (place_of_supply IS NULL OR place_of_supply ~ '^[0-9]{2}$')
);
ALTER TABLE "recurring_bill_lines" ADD CONSTRAINT "recurring_bill_lines_chk" CHECK (line_no > 0 AND quantity >= 0 AND unit_price >= 0);
ALTER TABLE "recurring_bill_runs" ADD CONSTRAINT "recurring_bill_runs_chk" CHECK (run_no > 0);

-- The schedule cannot be rewound or reshaped once it has run: runs already made stay numbered.
CREATE FUNCTION t2t_guard_recurring_bill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id <> OLD.org_id OR NEW.number <> OLD.number OR NEW.created_by_id <> OLD.created_by_id THEN
    RAISE EXCEPTION 'A recurring bill keeps its number and creator' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.next_run_no < OLD.next_run_no THEN
    RAISE EXCEPTION 'Recurring bill runs already made are not undone' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.next_run_no > 1 AND (NEW.start_date <> OLD.start_date OR NEW.frequency <> OLD.frequency OR NEW.month_end <> OLD.month_end OR NEW.contact_id <> OLD.contact_id) THEN
    RAISE EXCEPTION 'A recurring bill that has run keeps its vendor, start date, frequency and run day' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recurring_bills_guard BEFORE UPDATE ON "recurring_bills" FOR EACH ROW EXECUTE FUNCTION t2t_guard_recurring_bill();

-- The run history is append-only; the only change is losing the link to a deleted draft bill.
CREATE FUNCTION t2t_guard_recurring_bill_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.document_id IS NULL AND OLD.document_id IS NOT NULL
     AND (to_jsonb(NEW) - 'document_id') = (to_jsonb(OLD) - 'document_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The run history of a recurring bill is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER recurring_bill_runs_guard BEFORE UPDATE OR DELETE ON "recurring_bill_runs" FOR EACH ROW EXECUTE FUNCTION t2t_guard_recurring_bill_run();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recurring_bills', 'recurring_bill_lines', 'recurring_bill_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
