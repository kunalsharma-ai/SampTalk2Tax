-- CreateEnum
CREATE TYPE "InvoiceTemplateEngine" AS ENUM ('LAYOUT', 'HTML');

-- CreateEnum
CREATE TYPE "SignatureKind" AS ENUM ('DRAWN', 'UPLOADED', 'TYPED');















































































-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "template_id" UUID;

-- CreateTable
CREATE TABLE "invoice_templates" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "preset_id" VARCHAR(20) NOT NULL,
    "engine" "InvoiceTemplateEngine" NOT NULL DEFAULT 'LAYOUT',
    "layout" JSONB NOT NULL,
    "html" TEXT,
    "logo" BYTEA,
    "logo_type" VARCHAR(20),
    "logo_sha256" CHAR(64),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_signatures" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "SignatureKind" NOT NULL,
    "signer_name" VARCHAR(120) NOT NULL,
    "designation" VARCHAR(120),
    "image" BYTEA NOT NULL,
    "image_type" VARCHAR(20) NOT NULL,
    "image_sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_signatures" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "signature_id" UUID NOT NULL,
    "signed_by_id" UUID NOT NULL,
    "signer_name" VARCHAR(120) NOT NULL,
    "designation" VARCHAR(120),
    "image" BYTEA NOT NULL,
    "image_type" VARCHAR(20) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "signed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" VARCHAR(300),
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdrawn_by_id" UUID,
    "withdraw_reason" VARCHAR(300),

    CONSTRAINT "document_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_templates_org_id_idx" ON "invoice_templates"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_templates_id_org_id_key" ON "invoice_templates"("id", "org_id");

-- CreateIndex
CREATE INDEX "user_signatures_org_id_user_id_idx" ON "user_signatures"("org_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_signatures_id_org_id_key" ON "user_signatures"("id", "org_id");

-- CreateIndex
CREATE INDEX "document_signatures_org_id_document_id_idx" ON "document_signatures"("org_id", "document_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_template_fk" FOREIGN KEY ("template_id", "org_id") REFERENCES "invoice_templates"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_templates" ADD CONSTRAINT "invoice_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_signatures" ADD CONSTRAINT "user_signatures_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_signature_fk" FOREIGN KEY ("signature_id", "org_id") REFERENCES "user_signatures"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Rules the API also checks, kept here so no path can break them.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "invoice_templates"
  ADD CONSTRAINT "invoice_templates_name_chk" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "invoice_templates_html_chk" CHECK (("engine" = 'HTML') = ("html" IS NOT NULL) AND ("html" IS NULL OR octet_length("html") <= 200000)),
  ADD CONSTRAINT "invoice_templates_logo_chk" CHECK (
    ("logo" IS NULL AND "logo_type" IS NULL AND "logo_sha256" IS NULL)
    OR ("logo" IS NOT NULL AND "logo_type" IN ('image/png', 'image/jpeg', 'image/webp') AND octet_length("logo") <= 500000 AND "logo_sha256" IS NOT NULL)),
  ADD CONSTRAINT "invoice_templates_default_chk" CHECK (NOT ("is_default" AND "archived_at" IS NOT NULL)),
  ADD CONSTRAINT "invoice_templates_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "invoice_templates_updated_by_fk" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT;
-- One default template per organisation.
CREATE UNIQUE INDEX "invoice_templates_one_default" ON "invoice_templates" ("org_id") WHERE "is_default";
CREATE UNIQUE INDEX "invoice_templates_name_unique" ON "invoice_templates" ("org_id", lower("name")) WHERE "archived_at" IS NULL;

ALTER TABLE "user_signatures"
  ADD CONSTRAINT "user_signatures_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "user_signatures_image_chk" CHECK ("image_type" IN ('image/png', 'image/jpeg', 'image/webp') AND octet_length("image") BETWEEN 1 AND 300000),
  ADD CONSTRAINT "user_signatures_name_chk" CHECK (length(btrim("signer_name")) > 0);
-- One signature in use per member and organisation.
CREATE UNIQUE INDEX "user_signatures_one_active" ON "user_signatures" ("org_id", "user_id") WHERE "revoked_at" IS NULL;

ALTER TABLE "document_signatures"
  ADD CONSTRAINT "document_signatures_signed_by_fk" FOREIGN KEY ("signed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "document_signatures_withdrawn_by_fk" FOREIGN KEY ("withdrawn_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "document_signatures_hash_chk" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "document_signatures_image_chk" CHECK ("image_type" IN ('image/png', 'image/jpeg', 'image/webp') AND octet_length("image") BETWEEN 1 AND 300000),
  ADD CONSTRAINT "document_signatures_withdraw_chk" CHECK (("withdrawn_at" IS NULL) = ("withdrawn_by_id" IS NULL) AND ("withdrawn_at" IS NULL OR "withdraw_reason" IS NOT NULL));
-- One signature in force per document.
CREATE UNIQUE INDEX "document_signatures_one_active" ON "document_signatures" ("document_id") WHERE "withdrawn_at" IS NULL;

-- A signature image is never edited: it can only be revoked, once.
CREATE FUNCTION t2t_guard_user_signature() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Signatures are revoked, never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.org_id <> OLD.org_id OR NEW.user_id <> OLD.user_id
     OR NEW.kind <> OLD.kind OR NEW.signer_name <> OLD.signer_name OR NEW.designation IS DISTINCT FROM OLD.designation
     OR NEW.image <> OLD.image OR NEW.image_type <> OLD.image_type OR NEW.image_sha256 <> OLD.image_sha256 OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A signature changes only to be revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_signatures_guard BEFORE UPDATE OR DELETE ON "user_signatures" FOR EACH ROW EXECUTE FUNCTION t2t_guard_user_signature();

-- Signing: only posted invoices and credit notes, only with the signer's own signature in use.
-- Afterwards a signature on a document can only be withdrawn, once, with a reason.
CREATE FUNCTION t2t_guard_document_signature() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d record; s record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Document signatures are withdrawn, never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT kind, status INTO d FROM documents WHERE id = NEW.document_id AND org_id = NEW.org_id;
    IF d.kind NOT IN ('INVOICE', 'CREDIT_NOTE') OR d.status <> 'POSTED' THEN
      RAISE EXCEPTION 'Only posted invoices and credit notes can be signed' USING ERRCODE = 'check_violation';
    END IF;
    SELECT user_id, revoked_at INTO s FROM user_signatures WHERE id = NEW.signature_id AND org_id = NEW.org_id;
    IF s.user_id <> NEW.signed_by_id OR s.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'A document is signed with the signer''s own signature in use' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new signature cannot start withdrawn' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL OR NEW.org_id <> OLD.org_id OR NEW.document_id <> OLD.document_id
     OR NEW.signature_id <> OLD.signature_id OR NEW.signed_by_id <> OLD.signed_by_id OR NEW.signer_name <> OLD.signer_name
     OR NEW.designation IS DISTINCT FROM OLD.designation OR NEW.image <> OLD.image OR NEW.image_type <> OLD.image_type
     OR NEW.content_hash <> OLD.content_hash OR NEW.signed_at <> OLD.signed_at OR NEW.user_agent IS DISTINCT FROM OLD.user_agent THEN
    RAISE EXCEPTION 'A document signature changes only to be withdrawn' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_signatures_guard BEFORE INSERT OR UPDATE OR DELETE ON "document_signatures" FOR EACH ROW EXECUTE FUNCTION t2t_guard_document_signature();

-- Templates are archived, not deleted, once documents use them (the FK restricts); a template in use by a document cannot be archived either,
-- since its documents would print with a design no one can see or edit. The API checks this first and says so.
CREATE FUNCTION t2t_guard_invoice_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM documents WHERE template_id = OLD.id AND org_id = OLD.org_id AND status <> 'VOID') THEN
    RAISE EXCEPTION 'Template % is used by documents and cannot be archived', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_templates_guard BEFORE UPDATE ON "invoice_templates" FOR EACH ROW EXECUTE FUNCTION t2t_guard_invoice_template();

-- Documents print with an active template of a sales kind.
CREATE FUNCTION t2t_check_document_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.template_id IS NOT NULL AND NEW.template_id IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.template_id END) THEN
    IF NEW.kind NOT IN ('INVOICE', 'CREDIT_NOTE') THEN
      RAISE EXCEPTION 'Only invoices and credit notes have a print template' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM invoice_templates WHERE id = NEW.template_id AND archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Template % is archived', NEW.template_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_template_check BEFORE INSERT OR UPDATE ON "documents" FOR EACH ROW EXECUTE FUNCTION t2t_check_document_template();

-- Posted documents stay as they were posted. The one exception: the print template, which changes how it looks, not what it says.
CREATE OR REPLACE FUNCTION t2t_guard_document() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Posted document % cannot be deleted; void it instead', OLD.id USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'Void document % is immutable', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'POSTED' AND NEW.status = 'POSTED'
     AND (to_jsonb(NEW) - 'template_id' - 'updated_at') = (to_jsonb(OLD) - 'template_id' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'POSTED' THEN
    IF NEW.status <> 'VOID'
       OR (NEW.kind, NEW.number, NEW.contact_id, NEW.issue_date, NEW.due_date, NEW.currency, NEW.subtotal, NEW.tax_total, NEW.total, NEW.journal_entry_id, NEW.reference,
           NEW.place_of_supply, NEW.supplier_state, NEW.supply_nature, NEW.counterparty_gstin,
           NEW.reverse_charge, NEW.reverse_charge_tax, NEW.withholding_section_id, NEW.withholding_kind, NEW.withholding_subject, NEW.withholding_base,
           NEW.withholding_rate, NEW.withholding_amount, NEW.counterparty_pan)
          IS DISTINCT FROM
          (OLD.kind, OLD.number, OLD.contact_id, OLD.issue_date, OLD.due_date, OLD.currency, OLD.subtotal, OLD.tax_total, OLD.total, OLD.journal_entry_id, OLD.reference,
           OLD.place_of_supply, OLD.supplier_state, OLD.supply_nature, OLD.counterparty_gstin,
           OLD.reverse_charge, OLD.reverse_charge_tax, OLD.withholding_section_id, OLD.withholding_kind, OLD.withholding_subject, OLD.withholding_base,
           OLD.withholding_rate, OLD.withholding_amount, OLD.counterparty_pan) THEN
      RAISE EXCEPTION 'Posted document % is immutable; void it and issue a new one', OLD.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice_templates', 'user_signatures', 'document_signatures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
