-- AR-008 pro forma invoices: what the customer will be billed, before the sale. Posts nothing.
CREATE TABLE "pro_forma_invoices" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "contact_id" UUID NOT NULL,
    "quote_id" UUID,
    "issue_date" DATE NOT NULL,
    "valid_until" DATE NOT NULL,
    "place_of_supply" CHAR(2),
    "reference" VARCHAR(100),
    "terms" VARCHAR(4000),
    "memo" VARCHAR(1000),
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(24,6) NOT NULL,
    "tax_total" DECIMAL(24,6) NOT NULL,
    "total" DECIMAL(24,6) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'DRAFT',
    "issued_at" TIMESTAMPTZ(6),
    "cancel_reason" VARCHAR(500),
    "cancelled_at" TIMESTAMPTZ(6),
    "invoice_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "pro_forma_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pro_forma_invoices_org_id_number_key" ON "pro_forma_invoices"("org_id", "number");
CREATE UNIQUE INDEX "pro_forma_invoices_id_org_id_key" ON "pro_forma_invoices"("id", "org_id");
CREATE UNIQUE INDEX "pro_forma_invoices_invoice_id_key" ON "pro_forma_invoices"("invoice_id");
CREATE INDEX "pro_forma_invoices_org_id_status_idx" ON "pro_forma_invoices"("org_id", "status");
CREATE INDEX "pro_forma_invoices_org_id_contact_id_idx" ON "pro_forma_invoices"("org_id", "contact_id");
ALTER TABLE "pro_forma_invoices" ADD CONSTRAINT "pro_forma_invoices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pro_forma_invoices" ADD CONSTRAINT "pro_forma_invoices_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pro_forma_invoices" ADD CONSTRAINT "pro_forma_invoices_quote_fk" FOREIGN KEY ("quote_id", "org_id") REFERENCES "sales_quotes"("id", "org_id") ON DELETE SET NULL ("quote_id") ON UPDATE CASCADE;
-- Deleting the draft invoice made from it frees the pro forma to be invoiced again.
ALTER TABLE "pro_forma_invoices" ADD CONSTRAINT "pro_forma_invoices_invoice_fk" FOREIGN KEY ("invoice_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE SET NULL ("invoice_id") ON UPDATE CASCADE;
ALTER TABLE "pro_forma_invoices" ADD CONSTRAINT "pro_forma_invoices_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pro_forma_invoices" ADD CONSTRAINT "pro_forma_invoices_chk" CHECK (
  status IN ('DRAFT', 'ISSUED', 'CANCELLED')
  AND valid_until >= issue_date
  AND total = subtotal + tax_total
  AND (status = 'DRAFT') = (issued_at IS NULL)
  AND (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
  AND (invoice_id IS NULL OR status = 'ISSUED')
);

CREATE TABLE "pro_forma_invoice_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "pro_forma_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" VARCHAR(500),
    "account_id" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "unit_price" DECIMAL(24,6) NOT NULL,
    "tax_rate_id" UUID,
    "hsn_code" TEXT,
    "net_amount" DECIMAL(24,6) NOT NULL,
    "tax_amount" DECIMAL(24,6) NOT NULL,
    CONSTRAINT "pro_forma_invoice_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pro_forma_invoice_lines_pro_forma_id_line_no_key" ON "pro_forma_invoice_lines"("pro_forma_id", "line_no");
ALTER TABLE "pro_forma_invoice_lines" ADD CONSTRAINT "pro_forma_invoice_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pro_forma_invoice_lines" ADD CONSTRAINT "pro_forma_invoice_lines_parent_fk" FOREIGN KEY ("pro_forma_id", "org_id") REFERENCES "pro_forma_invoices"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pro_forma_invoice_lines" ADD CONSTRAINT "pro_forma_invoice_lines_account_fk" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pro_forma_invoice_lines" ADD CONSTRAINT "pro_forma_invoice_lines_tax_fk" FOREIGN KEY ("tax_rate_id", "org_id") REFERENCES "tax_rates"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Once issued, a pro forma's customer, dates, figures and lines stay as they were; only a draft is deleted;
-- the invoice made from it is a customer invoice of the same customer.
CREATE FUNCTION t2t_check_pro_forma() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only a draft pro forma invoice can be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' AND (
       NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.issue_date IS DISTINCT FROM OLD.issue_date OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    OR NEW.subtotal IS DISTINCT FROM OLD.subtotal OR NEW.tax_total IS DISTINCT FROM OLD.tax_total OR NEW.total IS DISTINCT FROM OLD.total
    OR NEW.place_of_supply IS DISTINCT FROM OLD.place_of_supply OR NEW.terms IS DISTINCT FROM OLD.terms OR NEW.number IS DISTINCT FROM OLD.number
    OR (OLD.status = 'CANCELLED')) THEN
    RAISE EXCEPTION 'A pro forma invoice is fixed once issued' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = NEW.invoice_id AND d.org_id = NEW.org_id AND d.kind = 'INVOICE' AND d.contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'A pro forma invoice is invoiced to its own customer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pro_forma_invoices_check BEFORE INSERT OR UPDATE OR DELETE ON "pro_forma_invoices" FOR EACH ROW EXECUTE FUNCTION t2t_check_pro_forma();

CREATE FUNCTION t2t_check_pro_forma_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s TEXT;
BEGIN
  SELECT status INTO s FROM pro_forma_invoices WHERE id = COALESCE(NEW.pro_forma_id, OLD.pro_forma_id);
  -- No parent row: it is being deleted (a draft), and its lines go with it.
  IF s IS NOT NULL AND s <> 'DRAFT' THEN
    RAISE EXCEPTION 'A pro forma invoice is fixed once issued' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER pro_forma_invoice_lines_check BEFORE INSERT OR UPDATE OR DELETE ON "pro_forma_invoice_lines" FOR EACH ROW EXECUTE FUNCTION t2t_check_pro_forma_line();

ALTER TABLE "pro_forma_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pro_forma_invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pro_forma_invoices" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "pro_forma_invoice_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pro_forma_invoice_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pro_forma_invoice_lines" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
