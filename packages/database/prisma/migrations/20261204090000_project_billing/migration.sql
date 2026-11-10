-- AR-013 milestone billing and AR-014 progress billing of sales orders.
CREATE TYPE "SalesBillingMethod" AS ENUM ('DELIVERY', 'MILESTONES', 'PROGRESS');
ALTER TABLE "sales_orders" ADD COLUMN "billing_method" "SalesBillingMethod" NOT NULL DEFAULT 'DELIVERY';

-- A milestone is a named share of the order's value. Invoicing it bills that share of every line;
-- the invoice is linked here (a void invoice frees the milestone; deleting the draft clears the link).
CREATE TABLE "sales_order_milestones" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "due_date" DATE,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_id" UUID,
    "document_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_order_milestones_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_order_milestones_order_id_seq_key" ON "sales_order_milestones"("order_id", "seq");
CREATE UNIQUE INDEX "sales_order_milestones_id_org_id_key" ON "sales_order_milestones"("id", "org_id");
CREATE INDEX "sales_order_milestones_org_id_document_id_idx" ON "sales_order_milestones"("org_id", "document_id");
ALTER TABLE "sales_order_milestones" ADD CONSTRAINT "sales_order_milestones_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_milestones" ADD CONSTRAINT "sales_order_milestones_order_fk" FOREIGN KEY ("order_id", "org_id") REFERENCES "sales_orders"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_order_milestones" ADD CONSTRAINT "sales_order_milestones_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE SET NULL ("document_id") ON UPDATE CASCADE;
ALTER TABLE "sales_order_milestones" ADD CONSTRAINT "sales_order_milestones_completed_by_fk" FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_milestones" ADD CONSTRAINT "sales_order_milestones_chk" CHECK (
  percent > 0 AND percent <= 100 AND length(btrim(name)) > 0 AND (completed_at IS NULL) = (completed_by_id IS NULL)
);

-- A progress claim: how complete the work is, and the invoice that bills up to that share.
CREATE TABLE "sales_order_progress_claims" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "percent_complete" DECIMAL(5,2) NOT NULL,
    "document_id" UUID NOT NULL,
    "note" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_order_progress_claims_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_order_progress_claims_document_id_key" ON "sales_order_progress_claims"("document_id");
CREATE INDEX "sales_order_progress_claims_org_id_order_id_idx" ON "sales_order_progress_claims"("org_id", "order_id");
ALTER TABLE "sales_order_progress_claims" ADD CONSTRAINT "sales_order_progress_claims_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_progress_claims" ADD CONSTRAINT "sales_order_progress_claims_order_fk" FOREIGN KEY ("order_id", "org_id") REFERENCES "sales_orders"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_progress_claims" ADD CONSTRAINT "sales_order_progress_claims_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_order_progress_claims" ADD CONSTRAINT "sales_order_progress_claims_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_progress_claims" ADD CONSTRAINT "sales_order_progress_claims_chk" CHECK (percent_complete > 0 AND percent_complete <= 100);

-- A milestone billed on an invoice that is not void keeps its name and share and is not removed.
CREATE FUNCTION t2t_check_sales_order_milestone() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st TEXT;
BEGIN
  IF OLD.document_id IS NOT NULL THEN
    SELECT status::text INTO st FROM documents WHERE id = OLD.document_id;
    IF st IS NOT NULL AND st <> 'VOID' THEN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'This milestone is invoiced; void or delete its invoice first' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.percent IS DISTINCT FROM OLD.percent OR NEW.name IS DISTINCT FROM OLD.name OR NEW.order_id IS DISTINCT FROM OLD.order_id
         OR (NEW.document_id IS DISTINCT FROM OLD.document_id AND NEW.document_id IS NOT NULL) THEN
        RAISE EXCEPTION 'This milestone is invoiced; void or delete its invoice first' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_order_milestones_check BEFORE UPDATE OR DELETE ON "sales_order_milestones" FOR EACH ROW EXECUTE FUNCTION t2t_check_sales_order_milestone();

-- Progress claims are a record: only deleting the draft invoice removes one.
CREATE FUNCTION t2t_guard_sales_order_progress_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A progress claim cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER sales_order_progress_claims_guard BEFORE UPDATE ON "sales_order_progress_claims" FOR EACH ROW EXECUTE FUNCTION t2t_guard_sales_order_progress_claim();

-- The billing method changes only while nothing on the order is billed on a live invoice.
CREATE FUNCTION t2t_check_sales_order_billing_method() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_method IS DISTINCT FROM OLD.billing_method AND EXISTS (
    SELECT 1 FROM sales_order_billings b JOIN documents d ON d.id = b.document_id
    WHERE b.order_id = NEW.id AND d.status::text <> 'VOID'
  ) THEN
    RAISE EXCEPTION 'Part of this order is billed; the billing method can no longer change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_orders_billing_method_check BEFORE UPDATE OF billing_method ON "sales_orders" FOR EACH ROW EXECUTE FUNCTION t2t_check_sales_order_billing_method();

ALTER TABLE "sales_order_milestones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_order_milestones" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_order_milestones" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "sales_order_progress_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_order_progress_claims" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_order_progress_claims" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
