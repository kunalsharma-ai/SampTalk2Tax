-- AR-028 revenue recognition: invoice lines recognised over their service period through
-- deferred revenue schedules.

CREATE TABLE "revenue_recognition_settings" (
    "org_id" UUID NOT NULL,
    "deferred_account_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "revenue_recognition_settings_pkey" PRIMARY KEY ("org_id")
);
ALTER TABLE "revenue_recognition_settings" ADD CONSTRAINT "revenue_recognition_settings_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "revenue_recognition_settings" ADD CONSTRAINT "revenue_recognition_settings_account_fk" FOREIGN KEY ("deferred_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "revenue_recognition_settings" ADD CONSTRAINT "revenue_recognition_settings_user_fk" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "invoice_line_recognition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "start_date" DATE NOT NULL,
    "months" INTEGER NOT NULL,
    "method" "DeferralMethod" NOT NULL,
    "schedule_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "invoice_line_recognition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_line_recognition_document_id_line_no_key" ON "invoice_line_recognition"("document_id", "line_no");
CREATE UNIQUE INDEX "invoice_line_recognition_schedule_id_key" ON "invoice_line_recognition"("schedule_id");
CREATE INDEX "invoice_line_recognition_org_id_idx" ON "invoice_line_recognition"("org_id");
ALTER TABLE "invoice_line_recognition" ADD CONSTRAINT "invoice_line_recognition_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_line_recognition" ADD CONSTRAINT "invoice_line_recognition_schedule_fk" FOREIGN KEY ("schedule_id", "org_id") REFERENCES "deferral_schedules"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_line_recognition" ADD CONSTRAINT "invoice_line_recognition_user_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_line_recognition" ADD CONSTRAINT "invoice_line_recognition_chk" CHECK (line_no > 0 AND months BETWEEN 1 AND 120);

-- Terms change only while the invoice is a draft; once posted the row points at its schedule for good.
CREATE FUNCTION t2t_guard_invoice_line_recognition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "DocumentStatus";
BEGIN
  SELECT status INTO s FROM documents WHERE id = COALESCE(NEW.document_id, OLD.document_id);
  IF TG_OP = 'DELETE' THEN
    IF s IS NULL OR (s = 'DRAFT' AND OLD.schedule_id IS NULL) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Revenue recognition of a posted invoice is kept' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF s <> 'DRAFT' OR NEW.schedule_id IS NOT NULL THEN
      RAISE EXCEPTION 'Revenue recognition is set while the invoice is a draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.document_id <> OLD.document_id OR NEW.org_id <> OLD.org_id OR NEW.line_no <> OLD.line_no THEN
    RAISE EXCEPTION 'Revenue recognition stays with its invoice line' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.schedule_id IS NOT NULL THEN
    RAISE EXCEPTION 'Revenue recognition of a posted invoice is kept' USING ERRCODE = 'check_violation';
  END IF;
  IF s <> 'DRAFT' AND NEW.schedule_id IS NULL THEN
    RAISE EXCEPTION 'Revenue recognition is set while the invoice is a draft' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_line_recognition_guard BEFORE INSERT OR UPDATE OR DELETE ON "invoice_line_recognition" FOR EACH ROW EXECUTE FUNCTION t2t_guard_invoice_line_recognition();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['revenue_recognition_settings', 'invoice_line_recognition'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
