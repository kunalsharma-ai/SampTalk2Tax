-- AP-015/016/017: purchase orders, goods receipts and matching bills against them.
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ISSUED', 'CLOSED', 'CANCELLED');
CREATE TYPE "MatchMode" AS ENUM ('TWO_WAY', 'THREE_WAY');
CREATE TYPE "GoodsReceiptStatus" AS ENUM ('RECORDED', 'CANCELLED');

CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "contact_id" UUID NOT NULL,
    "order_date" DATE NOT NULL,
    "expected_date" DATE,
    "place_of_supply" CHAR(2),
    "reference" VARCHAR(100),
    "terms" VARCHAR(4000),
    "memo" VARCHAR(1000),
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(24,6) NOT NULL,
    "tax_total" DECIMAL(24,6) NOT NULL,
    "total" DECIMAL(24,6) NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "match_mode" "MatchMode" NOT NULL DEFAULT 'THREE_WAY',
    "price_tolerance_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "quantity_tolerance_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "close_reason" VARCHAR(500),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_order_lines" (
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
    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "order_id" UUID NOT NULL,
    "receipt_date" DATE NOT NULL,
    "reference" VARCHAR(100),
    "memo" VARCHAR(1000),
    "status" "GoodsReceiptStatus" NOT NULL DEFAULT 'RECORDED',
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "goods_receipt_lines" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "rejected" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "note" VARCHAR(500),
    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bill_match_acceptances" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "accepted_by_id" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bill_match_acceptances_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "documents" ADD COLUMN "purchase_order_id" UUID;
ALTER TABLE "document_lines" ADD COLUMN "purchase_order_line_id" UUID;

CREATE UNIQUE INDEX "purchase_orders_org_id_number_key" ON "purchase_orders"("org_id", "number");
CREATE UNIQUE INDEX "purchase_orders_id_org_id_key" ON "purchase_orders"("id", "org_id");
CREATE INDEX "purchase_orders_org_id_status_idx" ON "purchase_orders"("org_id", "status");
CREATE INDEX "purchase_orders_org_id_contact_id_idx" ON "purchase_orders"("org_id", "contact_id");
CREATE UNIQUE INDEX "purchase_order_lines_order_id_line_no_key" ON "purchase_order_lines"("order_id", "line_no");
CREATE UNIQUE INDEX "purchase_order_lines_id_org_id_key" ON "purchase_order_lines"("id", "org_id");
CREATE UNIQUE INDEX "goods_receipts_org_id_number_key" ON "goods_receipts"("org_id", "number");
CREATE UNIQUE INDEX "goods_receipts_id_org_id_key" ON "goods_receipts"("id", "org_id");
CREATE INDEX "goods_receipts_org_id_order_id_idx" ON "goods_receipts"("org_id", "order_id");
CREATE UNIQUE INDEX "goods_receipt_lines_receipt_id_order_line_id_key" ON "goods_receipt_lines"("receipt_id", "order_line_id");
CREATE INDEX "goods_receipt_lines_order_line_id_idx" ON "goods_receipt_lines"("order_line_id");
CREATE INDEX "bill_match_acceptances_org_id_document_id_idx" ON "bill_match_acceptances"("org_id", "document_id");
CREATE INDEX "documents_org_id_purchase_order_id_idx" ON "documents"("org_id", "purchase_order_id");
CREATE INDEX "document_lines_purchase_order_line_id_idx" ON "document_lines"("purchase_order_line_id");

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_id_fkey" FOREIGN KEY ("order_id", "org_id") REFERENCES "purchase_orders"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_account_fk" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tax_fk" FOREIGN KEY ("tax_rate_id", "org_id") REFERENCES "tax_rates"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_order_fk" FOREIGN KEY ("order_id", "org_id") REFERENCES "purchase_orders"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_id_fkey" FOREIGN KEY ("receipt_id", "org_id") REFERENCES "goods_receipts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_order_line_fk" FOREIGN KEY ("order_line_id", "org_id") REFERENCES "purchase_order_lines"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Deleting a draft bill removes its acceptances with it.
ALTER TABLE "bill_match_acceptances" ADD CONSTRAINT "bill_match_acceptances_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bill_match_acceptances" ADD CONSTRAINT "bill_match_acceptances_accepted_by_fk" FOREIGN KEY ("accepted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_purchase_order_fk" FOREIGN KEY ("purchase_order_id", "org_id") REFERENCES "purchase_orders"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_purchase_order_line_fk" FOREIGN KEY ("purchase_order_line_id", "org_id") REFERENCES "purchase_order_lines"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_chk" CHECK (
  number > 0 AND subtotal >= 0 AND tax_total >= 0 AND total = subtotal + tax_total
  AND (expected_date IS NULL OR expected_date >= order_date)
  AND price_tolerance_percent BETWEEN 0 AND 100 AND quantity_tolerance_percent BETWEEN 0 AND 100
  AND ((status = 'DRAFT') = (issued_at IS NULL))
  AND ((status = 'CLOSED') = (closed_at IS NOT NULL AND close_reason IS NOT NULL))
  AND ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_chk" CHECK (line_no > 0 AND quantity > 0 AND unit_price >= 0 AND net_amount >= 0 AND tax_amount >= 0);
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_chk" CHECK (number > 0 AND ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)));
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_chk" CHECK (quantity >= 0 AND rejected >= 0 AND quantity + rejected > 0);
ALTER TABLE "bill_match_acceptances" ADD CONSTRAINT "bill_match_acceptances_chk" CHECK (length(btrim(reason)) > 0);

-- An order is fixed once issued; only a draft is deleted; a closed or cancelled order does not change.
CREATE FUNCTION t2t_check_purchase_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only a draft purchase order can be deleted' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.number <> OLD.number OR NEW.created_by_id <> OLD.created_by_id OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'A purchase order keeps its number and creator' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'A closed or cancelled purchase order does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.status = 'DRAFT' OR NEW.contact_id <> OLD.contact_id OR NEW.order_date <> OLD.order_date OR NEW.currency <> OLD.currency
    OR NEW.subtotal <> OLD.subtotal OR NEW.tax_total <> OLD.tax_total OR NEW.total <> OLD.total OR NEW.place_of_supply IS DISTINCT FROM OLD.place_of_supply
    OR NEW.match_mode <> OLD.match_mode OR NEW.price_tolerance_percent <> OLD.price_tolerance_percent OR NEW.quantity_tolerance_percent <> OLD.quantity_tolerance_percent
    OR NEW.terms IS DISTINCT FROM OLD.terms) THEN
    RAISE EXCEPTION 'A purchase order is fixed once issued' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_orders_check BEFORE UPDATE OR DELETE ON "purchase_orders" FOR EACH ROW EXECUTE FUNCTION t2t_check_purchase_order();

CREATE FUNCTION t2t_check_purchase_order_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s TEXT;
BEGIN
  SELECT status INTO s FROM purchase_orders WHERE id = COALESCE(NEW.order_id, OLD.order_id);
  -- No parent row: a draft is being deleted, and its lines go with it.
  IF s IS NOT NULL AND s <> 'DRAFT' THEN
    RAISE EXCEPTION 'A purchase order is fixed once issued' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER purchase_order_lines_check BEFORE INSERT OR UPDATE OR DELETE ON "purchase_order_lines" FOR EACH ROW EXECUTE FUNCTION t2t_check_purchase_order_line();

-- A goods receipt is never deleted; it is only cancelled (with a reason). Its lines never change.
CREATE FUNCTION t2t_check_goods_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Goods receipts are never deleted; cancel them instead' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM purchase_orders o WHERE o.id = NEW.order_id AND o.status = 'ISSUED') THEN
      RAISE EXCEPTION 'Goods are received only against an issued purchase order' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'CANCELLED' OR NEW.order_id <> OLD.order_id OR NEW.number <> OLD.number OR NEW.receipt_date <> OLD.receipt_date OR NEW.created_by_id <> OLD.created_by_id THEN
    RAISE EXCEPTION 'A goods receipt does not change; cancel it and record it again' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goods_receipts_check BEFORE INSERT OR UPDATE OR DELETE ON "goods_receipts" FOR EACH ROW EXECUTE FUNCTION t2t_check_goods_receipt();

CREATE FUNCTION t2t_check_goods_receipt_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'A goods receipt does not change; cancel it and record it again' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM goods_receipts r JOIN purchase_order_lines l ON l.order_id = r.order_id WHERE r.id = NEW.receipt_id AND l.id = NEW.order_line_id) THEN
    RAISE EXCEPTION 'A received line is on the receipt''s own purchase order' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goods_receipt_lines_check BEFORE INSERT OR UPDATE OR DELETE ON "goods_receipt_lines" FOR EACH ROW EXECUTE FUNCTION t2t_check_goods_receipt_line();

-- A bill line billing an order line: the bill is a bill to the order's vendor, for that order, and the order is not a draft.
CREATE FUNCTION t2t_check_document_po_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purchase_order_line_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM documents d JOIN purchase_order_lines l ON l.id = NEW.purchase_order_line_id JOIN purchase_orders o ON o.id = l.order_id
    WHERE d.id = NEW.document_id AND d.kind = 'BILL' AND d.purchase_order_id = o.id AND d.contact_id = o.contact_id AND o.status <> 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'A bill line is billed only against an issued purchase order of the same vendor' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_lines_po_check BEFORE INSERT OR UPDATE OF purchase_order_line_id ON "document_lines" FOR EACH ROW EXECUTE FUNCTION t2t_check_document_po_line();

CREATE FUNCTION t2t_check_document_po() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purchase_order_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM purchase_orders o WHERE o.id = NEW.purchase_order_id AND o.org_id = NEW.org_id AND o.contact_id = NEW.contact_id AND NEW.kind = 'BILL') THEN
    RAISE EXCEPTION 'A bill is matched only to a purchase order of the same vendor' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_po_check BEFORE INSERT OR UPDATE OF purchase_order_id, contact_id ON "documents" FOR EACH ROW EXECUTE FUNCTION t2t_check_document_po();

-- Acceptances are history: never changed, and removed only together with their draft bill.
CREATE FUNCTION t2t_check_bill_match_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'A match acceptance cannot be changed' USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (SELECT 1 FROM documents WHERE id = OLD.document_id) THEN
    RAISE EXCEPTION 'A match acceptance cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER bill_match_acceptances_check BEFORE UPDATE OR DELETE ON "bill_match_acceptances" FOR EACH ROW EXECUTE FUNCTION t2t_check_bill_match_acceptance();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines', 'bill_match_acceptances'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
