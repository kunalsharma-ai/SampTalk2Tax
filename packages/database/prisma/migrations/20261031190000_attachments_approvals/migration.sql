-- CreateEnum
CREATE TYPE "AttachmentEntity" AS ENUM ('DOCUMENT', 'PAYMENT', 'JOURNAL_ENTRY', 'BANK_STATEMENT_LINE');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "entity_type" "AttachmentEntity" NOT NULL,
    "entity_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),
    "removed_by_id" UUID,
    "removed_reason" TEXT,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_policies" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "document_kind" "DocumentKind" NOT NULL,
    "min_amount" DECIMAL(24,6) NOT NULL,
    "require_different_approver" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "document_id" UUID,
    "document_kind" "DocumentKind" NOT NULL,
    "contact_name" TEXT NOT NULL,
    "total" DECIMAL(24,6) NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "requested_by_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attachments_org_id_entity_type_entity_id_idx" ON "attachments"("org_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_id_org_id_key" ON "attachments"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_policies_org_id_document_kind_key" ON "approval_policies"("org_id", "document_kind");

-- CreateIndex
CREATE INDEX "approval_requests_org_id_status_idx" ON "approval_requests"("org_id", "status");

-- CreateIndex
CREATE INDEX "approval_requests_document_id_idx" ON "approval_requests"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_id_org_id_key" ON "approval_requests"("id", "org_id");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written integrity controls for attachments and approvals.
-- ---------------------------------------------------------------------------

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_size_chk" CHECK ("size_bytes" > 0 AND "size_bytes" <= 5242880 AND "size_bytes" = octet_length("content")),
  ADD CONSTRAINT "attachments_sha_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "attachments_type_chk" CHECK ("content_type" IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  ADD CONSTRAINT "attachments_removed_chk" CHECK (("removed_at" IS NULL) = ("removed_reason" IS NULL));
ALTER TABLE "approval_policies"
  ADD CONSTRAINT "approval_policies_min_chk" CHECK ("min_amount" >= 0);
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_total_chk" CHECK ("total" > 0),
  ADD CONSTRAINT "approval_requests_decided_chk" CHECK (("status" = 'PENDING') = ("decided_at" IS NULL));

-- At most one open (pending or approved) request per document.
CREATE UNIQUE INDEX "approval_requests_open_uniq" ON "approval_requests" ("document_id") WHERE "status" IN ('PENDING', 'APPROVED');

-- Attachments are evidence: bytes never change, rows are never deleted, removal happens once.
CREATE OR REPLACE FUNCTION t2t_guard_attachment() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Attachment % cannot be deleted; remove it instead', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.content <> OLD.content OR NEW.sha256 <> OLD.sha256 OR NEW.size_bytes <> OLD.size_bytes OR NEW.file_name <> OLD.file_name
     OR NEW.content_type <> OLD.content_type OR NEW.entity_type <> OLD.entity_type OR NEW.entity_id <> OLD.entity_id OR NEW.org_id <> OLD.org_id
     OR (OLD.removed_at IS NOT NULL AND (NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.removed_reason IS DISTINCT FROM OLD.removed_reason)) THEN
    RAISE EXCEPTION 'Attachment % cannot be changed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attachments_guard
  BEFORE UPDATE OR DELETE ON "attachments"
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_attachment();

-- Approval requests are history: never deleted; decisions are final except that an
-- approval is cancelled when the draft changes; the approver must differ from the
-- requester and the document's author when the policy says so.
CREATE OR REPLACE FUNCTION t2t_guard_approval_request() RETURNS trigger AS $$
DECLARE
  d record;
  separate boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Approval request % cannot be deleted', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT org_id, status INTO d FROM documents WHERE id = NEW.document_id;
    IF d.org_id IS DISTINCT FROM NEW.org_id OR d.status <> 'DRAFT' OR NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'Approval can only be requested for a draft in the same organisation' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  -- The document being deleted sets document_id to NULL; nothing else may change on that path.
  IF NEW.document_id IS DISTINCT FROM OLD.document_id AND NOT (NEW.document_id IS NULL AND NEW.status = OLD.status) THEN
    RAISE EXCEPTION 'Approval request % cannot be moved to another document', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.total <> OLD.total OR NEW.requested_by_id <> OLD.requested_by_id OR NEW.document_kind <> OLD.document_kind THEN
    RAISE EXCEPTION 'Approval request % cannot be changed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED')) OR (OLD.status = 'APPROVED' AND NEW.status = 'CANCELLED')) THEN
      RAISE EXCEPTION 'Approval request % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status = 'APPROVED' THEN
      SELECT doc.created_by_id, doc.status INTO d FROM documents doc WHERE doc.id = NEW.document_id;
      IF d.status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'Approval request % is for a document that is no longer a draft', OLD.id USING ERRCODE = 'P0001';
      END IF;
      SELECT p.require_different_approver INTO separate FROM approval_policies p WHERE p.org_id = NEW.org_id AND p.document_kind = NEW.document_kind;
      IF coalesce(separate, true) AND (NEW.decided_by_id = NEW.requested_by_id OR NEW.decided_by_id = d.created_by_id) THEN
        RAISE EXCEPTION 'Approval request % must be approved by someone other than its author and requester', OLD.id USING ERRCODE = 'P0001';
      END IF;
    END IF;
  ELSIF OLD.status <> 'PENDING' AND (NEW.decided_by_id IS DISTINCT FROM OLD.decided_by_id OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_note IS DISTINCT FROM OLD.decision_note) THEN
    RAISE EXCEPTION 'Approval request % decision cannot be changed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approval_requests_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "approval_requests"
  FOR EACH ROW EXECUTE FUNCTION t2t_guard_approval_request();

-- Any change to a draft cancels its open approval, so what was approved is what posts.
CREATE OR REPLACE FUNCTION t2t_invalidate_approval() RETURNS trigger AS $$
DECLARE
  doc_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'documents' THEN
    IF OLD.status <> 'DRAFT' OR NEW.status <> 'DRAFT' THEN RETURN NULL; END IF;
    IF (NEW.contact_id, NEW.issue_date, NEW.due_date, NEW.reference, NEW.memo, NEW.total, NEW.subtotal, NEW.tax_total)
       IS NOT DISTINCT FROM (OLD.contact_id, OLD.issue_date, OLD.due_date, OLD.reference, OLD.memo, OLD.total, OLD.subtotal, OLD.tax_total) THEN
      RETURN NULL;
    END IF;
    doc_id := NEW.id;
  ELSE
    doc_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
    IF NOT EXISTS (SELECT 1 FROM documents WHERE id = doc_id AND status = 'DRAFT') THEN RETURN NULL; END IF;
  END IF;
  UPDATE approval_requests
     SET status = 'CANCELLED', decided_at = coalesce(decided_at, now()),
         decision_note = coalesce(decision_note || ' · ', '') || 'Cancelled because the draft was changed'
   WHERE document_id = doc_id AND status IN ('PENDING', 'APPROVED');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_invalidate_approval
  AFTER UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION t2t_invalidate_approval();
CREATE TRIGGER document_lines_invalidate_approval
  AFTER INSERT OR UPDATE OR DELETE ON "document_lines"
  FOR EACH ROW EXECUTE FUNCTION t2t_invalidate_approval();

-- A document covered by an active policy posts only with an approval for exactly its total.
CREATE OR REPLACE FUNCTION t2t_check_document_approval() RETURNS trigger AS $$
DECLARE
  needed boolean;
BEGIN
  IF NEW.status <> 'POSTED' OR (TG_OP = 'UPDATE' AND OLD.status = 'POSTED') THEN RETURN NEW; END IF;
  SELECT EXISTS (SELECT 1 FROM approval_policies p WHERE p.org_id = NEW.org_id AND p.document_kind = NEW.kind AND p.is_active AND NEW.total >= p.min_amount)
    INTO needed;
  IF needed AND NOT EXISTS (SELECT 1 FROM approval_requests r WHERE r.document_id = NEW.id AND r.status = 'APPROVED' AND r.total = NEW.total) THEN
    RAISE EXCEPTION 'Document % needs an approval before it can post', NEW.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_approval_check
  BEFORE INSERT OR UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION t2t_check_document_approval();
