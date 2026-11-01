-- CreateEnum
CREATE TYPE "EWayBillStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransportMode" AS ENUM ('ROAD', 'RAIL', 'AIR', 'SHIP');

-- CreateTable
CREATE TABLE "e_way_bill_settings" (
    "org_id" UUID NOT NULL,
    "threshold" DECIMAL(18,2) NOT NULL DEFAULT 50000,
    "intra_state_threshold" DECIMAL(18,2),
    "address1" TEXT NOT NULL,
    "address2" TEXT,
    "city" TEXT NOT NULL,
    "pincode" CHAR(6) NOT NULL,
    "goods_unit" TEXT NOT NULL DEFAULT 'NOS',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "e_way_bill_settings_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "e_way_bills" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "number" CHAR(12) NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6),
    "distance_km" INTEGER NOT NULL,
    "vehicle_type" CHAR(1) NOT NULL DEFAULT 'R',
    "transport_mode" "TransportMode",
    "vehicle_no" TEXT,
    "transporter_id" CHAR(15),
    "transporter_name" TEXT,
    "trans_doc_no" TEXT,
    "trans_doc_date" DATE,
    "payload_hash" CHAR(64) NOT NULL,
    "status" "EWayBillStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" CHAR(1),
    "cancel_remark" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_by_id" UUID,

    CONSTRAINT "e_way_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "e_way_bill_vehicle_updates" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "e_way_bill_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "transport_mode" "TransportMode" NOT NULL,
    "vehicle_no" TEXT,
    "trans_doc_no" TEXT,
    "trans_doc_date" DATE,
    "from_place" TEXT NOT NULL,
    "from_state_code" CHAR(2) NOT NULL,
    "reason" CHAR(1) NOT NULL,
    "remark" TEXT NOT NULL,
    "valid_until" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e_way_bill_vehicle_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "e_way_bills_document_id_idx" ON "e_way_bills"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "e_way_bills_id_org_id_key" ON "e_way_bills"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "e_way_bills_org_id_number_key" ON "e_way_bills"("org_id", "number");

-- CreateIndex
CREATE INDEX "e_way_bill_vehicle_updates_e_way_bill_id_idx" ON "e_way_bill_vehicle_updates"("e_way_bill_id");

-- AddForeignKey
ALTER TABLE "e_way_bill_settings" ADD CONSTRAINT "e_way_bill_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_way_bills" ADD CONSTRAINT "e_way_bills_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_way_bills" ADD CONSTRAINT "e_way_bills_document_id_org_id_fkey" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_way_bill_vehicle_updates" ADD CONSTRAINT "e_way_bill_vehicle_updates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_way_bill_vehicle_updates" ADD CONSTRAINT "e_way_bill_vehicle_updates_e_way_bill_id_org_id_fkey" FOREIGN KEY ("e_way_bill_id", "org_id") REFERENCES "e_way_bills"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ------------------------------------------------------------------ hand-written

ALTER TABLE "e_way_bill_settings"
  ADD CONSTRAINT "e_way_bill_settings_chk" CHECK (
    "pincode" ~ '^[1-9][0-9]{5}$' AND length(btrim("address1")) BETWEEN 1 AND 120 AND length(btrim("city")) BETWEEN 1 AND 50
    AND "goods_unit" ~ '^[A-Z]{3,8}$' AND "threshold" >= 0 AND ("intra_state_threshold" IS NULL OR "intra_state_threshold" >= 0));

ALTER TABLE "e_way_bills"
  ADD CONSTRAINT "e_way_bills_chk" CHECK (
    "number" ~ '^[0-9]{12}$' AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "distance_km" BETWEEN 1 AND 4000 AND "vehicle_type" IN ('R', 'O')
    AND ("transporter_id" IS NULL OR "transporter_id" ~ '^[0-9]{2}[0-9A-Z]{13}$')
    AND ("valid_until" IS NULL OR "valid_until" > "generated_at")
    AND ("transport_mode" IS NOT NULL OR ("vehicle_no" IS NULL AND "trans_doc_no" IS NULL AND "valid_until" IS NULL))),
  ADD CONSTRAINT "e_way_bills_cancel_chk" CHECK (
    ("status" = 'ACTIVE' AND "cancelled_at" IS NULL AND "cancel_reason" IS NULL AND "cancelled_by_id" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancel_reason" IN ('1', '2', '3', '4') AND "cancelled_by_id" IS NOT NULL
        AND "cancelled_at" >= "generated_at" AND "cancelled_at" <= "generated_at" + interval '24 hours'));
-- One live e-way bill per document.
CREATE UNIQUE INDEX "e_way_bills_document_live_uniq" ON "e_way_bills" ("document_id") WHERE "status" = 'ACTIVE';

ALTER TABLE "e_way_bill_vehicle_updates"
  ADD CONSTRAINT "e_way_bill_vehicle_updates_chk" CHECK (
    "reason" IN ('1', '2', '3', '4') AND "from_state_code" ~ '^[0-9]{2}$' AND length(btrim("from_place")) BETWEEN 1 AND 50
    AND length(btrim("remark")) BETWEEN 1 AND 50 AND ("vehicle_no" IS NOT NULL OR "trans_doc_no" IS NOT NULL));

CREATE OR REPLACE FUNCTION t2t_guard_e_way_bill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'E-way bill records cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = NEW.document_id AND d.status = 'POSTED' AND d.kind = 'INVOICE') THEN
      RAISE EXCEPTION 'An e-way bill can be recorded only for a posted invoice' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'CANCELLED' OR NEW.status <> 'CANCELLED'
     OR (NEW.org_id, NEW.document_id, NEW.number, NEW.generated_at, NEW.valid_until, NEW.distance_km, NEW.vehicle_type, NEW.transport_mode, NEW.vehicle_no,
         NEW.transporter_id, NEW.transporter_name, NEW.trans_doc_no, NEW.trans_doc_date, NEW.payload_hash, NEW.created_by_id, NEW.created_at)
        IS DISTINCT FROM (OLD.org_id, OLD.document_id, OLD.number, OLD.generated_at, OLD.valid_until, OLD.distance_km, OLD.vehicle_type, OLD.transport_mode, OLD.vehicle_no,
         OLD.transporter_id, OLD.transporter_name, OLD.trans_doc_no, OLD.trans_doc_date, OLD.payload_hash, OLD.created_by_id, OLD.created_at) THEN
    RAISE EXCEPTION 'An e-way bill record is immutable; record vehicle changes as Part B updates and only its cancellation otherwise' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER e_way_bills_guard BEFORE INSERT OR UPDATE OR DELETE ON "e_way_bills" FOR EACH ROW EXECUTE FUNCTION t2t_guard_e_way_bill();

CREATE OR REPLACE FUNCTION t2t_guard_e_way_bill_vehicle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Part B updates cannot be changed or deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM e_way_bills b WHERE b.id = NEW.e_way_bill_id AND b.status = 'ACTIVE' AND NEW.updated_at >= b.generated_at) THEN
    RAISE EXCEPTION 'Part B can be updated only on a live e-way bill, after it was generated' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER e_way_bill_vehicle_updates_guard BEFORE INSERT OR UPDATE OR DELETE ON "e_way_bill_vehicle_updates" FOR EACH ROW EXECUTE FUNCTION t2t_guard_e_way_bill_vehicle();

-- A document with a live e-way bill cannot be voided in the books: cancel the e-way bill on
-- the portal first (within 24 hours).
CREATE OR REPLACE FUNCTION t2t_guard_document_ewb() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'VOID' AND OLD.status <> 'VOID' AND EXISTS (SELECT 1 FROM e_way_bills e WHERE e.document_id = NEW.id AND e.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'Document % has a live e-way bill; cancel it on the portal first', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_ewb_guard BEFORE UPDATE ON "documents" FOR EACH ROW EXECUTE FUNCTION t2t_guard_document_ewb();

-- Row-level security, as for every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['e_way_bill_settings', 'e_way_bills', 'e_way_bill_vehicle_updates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
