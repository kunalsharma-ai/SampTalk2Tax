-- AP-019 supplier tax validation: what a person saw when they looked a vendor's GSTIN up on the
-- GST portal. Kept as a history; never changed or deleted.

CREATE TABLE "supplier_gstin_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "gstin" CHAR(15) NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "taxpayer_type" VARCHAR(14),
    "legal_name" VARCHAR(200),
    "effective_date" DATE,
    "checked_on" DATE NOT NULL,
    "note" VARCHAR(500),
    "recorded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "supplier_gstin_checks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "supplier_gstin_checks_org_id_contact_id_idx" ON "supplier_gstin_checks"("org_id", "contact_id", "checked_on");
ALTER TABLE "supplier_gstin_checks" ADD CONSTRAINT "supplier_gstin_checks_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_gstin_checks" ADD CONSTRAINT "supplier_gstin_checks_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_gstin_checks" ADD CONSTRAINT "supplier_gstin_checks_user_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_gstin_checks" ADD CONSTRAINT "supplier_gstin_checks_chk" CHECK (
  gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'
  AND status IN ('ACTIVE', 'CANCELLED', 'SUSPENDED', 'NOT_FOUND')
  AND (taxpayer_type IS NULL OR taxpayer_type IN ('REGULAR', 'COMPOSITION', 'SEZ', 'CASUAL', 'NON_RESIDENT', 'OTHER'))
  AND (status = 'ACTIVE' OR taxpayer_type IS NULL OR status <> 'NOT_FOUND')
  AND (effective_date IS NULL OR status IN ('CANCELLED', 'SUSPENDED'))
);

CREATE FUNCTION t2t_guard_supplier_gstin_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'GST portal checks are kept as recorded; record a new check instead' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER supplier_gstin_checks_guard BEFORE UPDATE OR DELETE ON "supplier_gstin_checks" FOR EACH ROW EXECUTE FUNCTION t2t_guard_supplier_gstin_check();

ALTER TABLE "supplier_gstin_checks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_gstin_checks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "supplier_gstin_checks" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
