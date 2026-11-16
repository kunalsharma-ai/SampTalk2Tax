-- CRM slice 2: quotations, sales orders and the invoices that bill them.
CREATE TYPE "SalesQuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'SUPERSEDED');
CREATE TYPE "SalesOrderStatus" AS ENUM ('OPEN', 'CANCELLED');

CREATE TABLE "sales_quotes" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "previous_id" UUID,
    "contact_id" UUID NOT NULL,
    "deal_id" UUID,
    "status" "SalesQuoteStatus" NOT NULL DEFAULT 'DRAFT',
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
    "sent_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "decline_reason" VARCHAR(500),
    "order_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "sales_quotes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_quote_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" VARCHAR(500),
    "account_id" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "unit_price" DECIMAL(24,6) NOT NULL,
    "tax_rate_id" UUID,
    "hsn_code" TEXT,
    "net_amount" DECIMAL(24,6) NOT NULL,
    "tax_amount" DECIMAL(24,6) NOT NULL,
    CONSTRAINT "sales_quote_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_orders" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "contact_id" UUID NOT NULL,
    "quote_id" UUID,
    "deal_id" UUID,
    "order_date" DATE NOT NULL,
    "place_of_supply" CHAR(2),
    "reference" VARCHAR(100),
    "memo" VARCHAR(1000),
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(24,6) NOT NULL,
    "tax_total" DECIMAL(24,6) NOT NULL,
    "total" DECIMAL(24,6) NOT NULL,
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'OPEN',
    "cancel_reason" VARCHAR(500),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_order_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" VARCHAR(500),
    "account_id" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "unit_price" DECIMAL(24,6) NOT NULL,
    "tax_rate_id" UUID,
    "hsn_code" TEXT,
    "net_amount" DECIMAL(24,6) NOT NULL,
    "tax_amount" DECIMAL(24,6) NOT NULL,
    CONSTRAINT "sales_order_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_order_billings" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_order_billings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_quotes_org_id_number_revision_key" ON "sales_quotes"("org_id", "number", "revision");
CREATE UNIQUE INDEX "sales_quotes_id_org_id_key" ON "sales_quotes"("id", "org_id");
CREATE INDEX "sales_quotes_org_id_status_idx" ON "sales_quotes"("org_id", "status");
CREATE INDEX "sales_quotes_org_id_contact_id_idx" ON "sales_quotes"("org_id", "contact_id");
CREATE UNIQUE INDEX "sales_quote_lines_quote_id_line_no_key" ON "sales_quote_lines"("quote_id", "line_no");
CREATE UNIQUE INDEX "sales_quote_lines_id_org_id_key" ON "sales_quote_lines"("id", "org_id");
CREATE UNIQUE INDEX "sales_orders_org_id_number_key" ON "sales_orders"("org_id", "number");
CREATE UNIQUE INDEX "sales_orders_id_org_id_key" ON "sales_orders"("id", "org_id");
CREATE UNIQUE INDEX "sales_orders_quote_id_key" ON "sales_orders"("quote_id");
CREATE INDEX "sales_orders_org_id_status_idx" ON "sales_orders"("org_id", "status");
CREATE INDEX "sales_orders_org_id_contact_id_idx" ON "sales_orders"("org_id", "contact_id");
CREATE UNIQUE INDEX "sales_order_lines_order_id_line_no_key" ON "sales_order_lines"("order_id", "line_no");
CREATE UNIQUE INDEX "sales_order_lines_id_org_id_key" ON "sales_order_lines"("id", "org_id");
CREATE INDEX "sales_order_billings_org_id_document_id_idx" ON "sales_order_billings"("org_id", "document_id");
CREATE INDEX "sales_order_billings_order_line_id_idx" ON "sales_order_billings"("order_line_id");
-- A quotation has at most one revision after it.
CREATE UNIQUE INDEX "sales_quotes_previous_key" ON "sales_quotes"("previous_id") WHERE "previous_id" IS NOT NULL;

ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_deal_fk" FOREIGN KEY ("deal_id", "org_id") REFERENCES "crm_deals"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_previous_fk" FOREIGN KEY ("previous_id", "org_id") REFERENCES "sales_quotes"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_quote_lines" ADD CONSTRAINT "sales_quote_lines_quote_id_fkey" FOREIGN KEY ("quote_id", "org_id") REFERENCES "sales_quotes"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_quote_lines" ADD CONSTRAINT "sales_quote_lines_account_fk" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_quote_lines" ADD CONSTRAINT "sales_quote_lines_tax_fk" FOREIGN KEY ("tax_rate_id", "org_id") REFERENCES "tax_rates"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quote_fk" FOREIGN KEY ("quote_id", "org_id") REFERENCES "sales_quotes"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_deal_fk" FOREIGN KEY ("deal_id", "org_id") REFERENCES "crm_deals"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_order_fk" FOREIGN KEY ("order_id", "org_id") REFERENCES "sales_orders"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_order_id_fkey" FOREIGN KEY ("order_id", "org_id") REFERENCES "sales_orders"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_account_fk" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_tax_fk" FOREIGN KEY ("tax_rate_id", "org_id") REFERENCES "tax_rates"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_billings" ADD CONSTRAINT "sales_order_billings_order_id_fkey" FOREIGN KEY ("order_id", "org_id") REFERENCES "sales_orders"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_billings" ADD CONSTRAINT "sales_order_billings_order_line_id_fkey" FOREIGN KEY ("order_line_id", "org_id") REFERENCES "sales_order_lines"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Deleting a draft invoice frees what it billed.
ALTER TABLE "sales_order_billings" ADD CONSTRAINT "sales_order_billings_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_order_billings" ADD CONSTRAINT "sales_order_billings_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_chk" CHECK (
  number > 0 AND revision > 0 AND valid_until >= issue_date AND subtotal >= 0 AND tax_total >= 0 AND total = subtotal + tax_total
  AND ((revision = 1) = (previous_id IS NULL))
  AND ((status = 'DRAFT') = (sent_at IS NULL))
  AND (status NOT IN ('ACCEPTED', 'DECLINED') OR decided_at IS NOT NULL)
  AND (status <> 'DECLINED' OR decline_reason IS NOT NULL)
  AND (decline_reason IS NULL OR status IN ('DECLINED', 'SUPERSEDED'))
  AND ((status = 'ACCEPTED') = (order_id IS NOT NULL))
);
ALTER TABLE "sales_quote_lines" ADD CONSTRAINT "sales_quote_lines_chk" CHECK (line_no > 0 AND quantity > 0 AND unit_price >= 0 AND net_amount >= 0 AND tax_amount >= 0);
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_chk" CHECK (
  number > 0 AND subtotal >= 0 AND tax_total >= 0 AND total = subtotal + tax_total
  AND ((status = 'CANCELLED') = (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL))
);
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_chk" CHECK (line_no > 0 AND quantity > 0 AND unit_price >= 0 AND net_amount >= 0 AND tax_amount >= 0);
ALTER TABLE "sales_order_billings" ADD CONSTRAINT "sales_order_billings_chk" CHECK (quantity > 0);

-- A quotation's lines change only while it is a draft; quotations and orders are never deleted
-- (a draft quotation can be, with its lines); an order's lines never change.
CREATE FUNCTION t2t_guard_sales_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only a draft quotation can be deleted' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.number <> OLD.number OR NEW.revision <> OLD.revision OR NEW.previous_id IS DISTINCT FROM OLD.previous_id OR NEW.created_by_id <> OLD.created_by_id THEN
    RAISE EXCEPTION 'A quotation keeps its number, revision and creator' USING ERRCODE = 'check_violation';
  END IF;
  -- Sending a revision supersedes the quotation before it, even a declined one; nothing else changes after an answer.
  IF OLD.status IN ('ACCEPTED', 'SUPERSEDED') OR (OLD.status = 'DECLINED' AND (NEW.status <> 'SUPERSEDED' OR NEW.decline_reason IS DISTINCT FROM OLD.decline_reason OR NEW.decided_at IS DISTINCT FROM OLD.decided_at)) THEN
    RAISE EXCEPTION 'An accepted, declined or superseded quotation does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'SENT' AND (NEW.contact_id <> OLD.contact_id OR NEW.total <> OLD.total OR NEW.subtotal <> OLD.subtotal OR NEW.issue_date <> OLD.issue_date OR NEW.valid_until <> OLD.valid_until OR NEW.terms IS DISTINCT FROM OLD.terms) THEN
    RAISE EXCEPTION 'A sent quotation does not change; revise it instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_quotes_guard BEFORE UPDATE OR DELETE ON "sales_quotes" FOR EACH ROW EXECUTE FUNCTION t2t_guard_sales_quote();

CREATE FUNCTION t2t_guard_sales_quote_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "SalesQuoteStatus";
BEGIN
  SELECT status INTO s FROM sales_quotes WHERE id = COALESCE(NEW.quote_id, OLD.quote_id);
  IF s IS NOT NULL AND s <> 'DRAFT' THEN
    RAISE EXCEPTION 'Only a draft quotation''s lines change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER sales_quote_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "sales_quote_lines" FOR EACH ROW EXECUTE FUNCTION t2t_guard_sales_quote_line();

CREATE FUNCTION t2t_guard_sales_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Sales orders are never deleted; cancel them instead' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.number <> OLD.number OR NEW.contact_id <> OLD.contact_id OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR NEW.total <> OLD.total OR NEW.subtotal <> OLD.subtotal OR NEW.tax_total <> OLD.tax_total OR NEW.created_by_id <> OLD.created_by_id THEN
    RAISE EXCEPTION 'A sales order keeps its customer, figures and number' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'A cancelled sales order does not change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_orders_guard BEFORE UPDATE OR DELETE ON "sales_orders" FOR EACH ROW EXECUTE FUNCTION t2t_guard_sales_order();

CREATE FUNCTION t2t_guard_sales_order_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A sales order''s lines never change' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER sales_order_lines_guard BEFORE UPDATE OR DELETE ON "sales_order_lines" FOR EACH ROW EXECUTE FUNCTION t2t_guard_sales_order_line();

CREATE FUNCTION t2t_guard_sales_order_billing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'An order billing never changes' USING ERRCODE = 'check_violation';
  END IF;
  -- Removed only together with its draft invoice (the cascade runs after the document row is gone).
  IF EXISTS (SELECT 1 FROM documents WHERE id = OLD.document_id) THEN
    RAISE EXCEPTION 'An order billing goes only with its draft invoice' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER sales_order_billings_guard BEFORE UPDATE OR DELETE ON "sales_order_billings" FOR EACH ROW EXECUTE FUNCTION t2t_guard_sales_order_billing();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_quotes', 'sales_quote_lines', 'sales_orders', 'sales_order_lines', 'sales_order_billings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
