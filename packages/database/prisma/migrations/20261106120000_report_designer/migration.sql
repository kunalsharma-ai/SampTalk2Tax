-- CreateTable
CREATE TABLE "report_designs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "layout" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "report_designs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_runs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "design_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "content" JSONB NOT NULL,
    "commentary" JSONB NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "finalised_by_id" UUID,
    "finalised_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_ai_calls" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "request" VARCHAR(8000) NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "result" JSONB,
    "error_code" VARCHAR(40),
    "error_message" VARCHAR(500),
    "model" VARCHAR(100),
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "report_ai_calls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_designs_org_id_number_key" ON "report_designs"("org_id", "number");
CREATE UNIQUE INDEX "report_designs_org_id_name_key" ON "report_designs"("org_id", "name");
CREATE UNIQUE INDEX "report_designs_org_id_id_key" ON "report_designs"("org_id", "id");
CREATE UNIQUE INDEX "report_runs_org_id_number_key" ON "report_runs"("org_id", "number");
CREATE INDEX "report_runs_org_id_design_id_month_idx" ON "report_runs"("org_id", "design_id", "month");
CREATE INDEX "report_ai_calls_org_id_created_at_idx" ON "report_ai_calls"("org_id", "created_at");

ALTER TABLE "report_designs" ADD CONSTRAINT "report_designs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_design_id_fkey" FOREIGN KEY ("design_id") REFERENCES "report_designs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "report_ai_calls" ADD CONSTRAINT "report_ai_calls_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A report belongs to a design of the same organisation.
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_design_org_fkey" FOREIGN KEY ("org_id", "design_id") REFERENCES "report_designs"("org_id", "id") ON DELETE RESTRICT;

ALTER TABLE "report_designs" ADD CONSTRAINT "report_designs_layout_check" CHECK (jsonb_typeof("layout") = 'object' AND jsonb_typeof("layout"->'sections') = 'array' AND jsonb_array_length("layout"->'sections') BETWEEN 1 AND 30);
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_status_check" CHECK ("status" IN ('DRAFT', 'FINAL'));
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_month_check" CHECK ("month" ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_final_check" CHECK (("status" = 'FINAL') = ("finalised_at" IS NOT NULL AND "finalised_by_id" IS NOT NULL));
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_commentary_check" CHECK (jsonb_typeof("commentary") = 'array');
ALTER TABLE "report_ai_calls" ADD CONSTRAINT "report_ai_calls_kind_check" CHECK ("kind" IN ('DESIGN', 'COMMENTARY'));
ALTER TABLE "report_ai_calls" ADD CONSTRAINT "report_ai_calls_status_check" CHECK ("status" IN ('DONE', 'FAILED'));

-- A final report is a record: it can never be changed or deleted.
CREATE FUNCTION t2t_report_runs_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'FINAL' THEN
    RAISE EXCEPTION 'a final report cannot be changed or deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_runs_final BEFORE UPDATE OR DELETE ON "report_runs" FOR EACH ROW EXECUTE FUNCTION t2t_report_runs_final();

ALTER TABLE "report_designs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_designs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "report_designs" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "report_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "report_runs" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "report_ai_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_ai_calls" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "report_ai_calls" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
