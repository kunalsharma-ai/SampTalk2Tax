-- CRM slice 4: Customer 360. Projects can belong to a customer (their costs are the customer's
-- direct costs), and a customer can be put on credit hold (no invoice posts until it is lifted).

ALTER TABLE "dimension_values" ADD COLUMN "contact_id" UUID;
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_contact_fkey"
  FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_contact_project_check"
  CHECK ("contact_id" IS NULL OR "type" = 'PROJECT');
CREATE INDEX "dimension_values_org_id_contact_id_idx" ON "dimension_values"("org_id", "contact_id");

ALTER TABLE "contacts" ADD COLUMN "credit_hold" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "contacts" ADD COLUMN "credit_hold_reason" VARCHAR(500);
ALTER TABLE "contacts" ADD COLUMN "credit_hold_at" TIMESTAMPTZ(6);
ALTER TABLE "contacts" ADD COLUMN "credit_hold_by_id" UUID;
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_credit_hold_by_fkey"
  FOREIGN KEY ("credit_hold_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_credit_hold_check"
  CHECK (NOT "credit_hold" OR ("credit_hold_reason" IS NOT NULL AND "credit_hold_at" IS NOT NULL AND "credit_hold_by_id" IS NOT NULL));

