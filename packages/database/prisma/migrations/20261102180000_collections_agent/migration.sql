-- M5 slice 3: AI collections. The model drafts payment reminders; a person approves, edits or rejects each one.

-- CreateEnum
CREATE TYPE "CollectionRunStatus" AS ENUM ('RUNNING', 'DONE');

-- CreateEnum
CREATE TYPE "CollectionDraftStatus" AS ENUM ('DRAFTING', 'READY', 'SENT', 'SEND_FAILED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "collection_runs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "status" "CollectionRunStatus" NOT NULL DEFAULT 'RUNNING',
    "started_by_id" UUID NOT NULL,
    "skipped" JSONB NOT NULL DEFAULT '[]',
    "model" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "collection_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_drafts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "CollectionDraftStatus" NOT NULL DEFAULT 'DRAFTING',
    "to_email" VARCHAR(320) NOT NULL,
    "facts" JSONB NOT NULL,
    "risk" VARCHAR(10),
    "risk_reasons" JSONB NOT NULL DEFAULT '[]',
    "ai_subject" VARCHAR(300),
    "ai_body" TEXT,
    "subject" VARCHAR(300),
    "body" TEXT,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "model" VARCHAR(100) NOT NULL,
    "served_model" VARCHAR(100),
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "error_code" VARCHAR(40),
    "error_message" VARCHAR(1000),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" VARCHAR(500),
    "send_attempts" INTEGER NOT NULL DEFAULT 0,
    "send_log" JSONB NOT NULL DEFAULT '[]',
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "collection_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collection_runs_org_id_created_at_idx" ON "collection_runs"("org_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "collection_runs_id_org_id_key" ON "collection_runs"("id", "org_id");

-- CreateIndex
CREATE INDEX "collection_drafts_org_id_status_created_at_idx" ON "collection_drafts"("org_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "collection_drafts_org_id_contact_id_created_at_idx" ON "collection_drafts"("org_id", "contact_id", "created_at");

-- AddForeignKey
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_drafts" ADD CONSTRAINT "collection_drafts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_drafts" ADD CONSTRAINT "collection_drafts_run_id_org_id_fkey" FOREIGN KEY ("run_id", "org_id") REFERENCES "collection_runs"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_drafts" ADD CONSTRAINT "collection_drafts_contact_id_org_id_fkey" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One drafting run at a time per organisation.
CREATE UNIQUE INDEX "collection_runs_one_running" ON "collection_runs"("org_id") WHERE "status" = 'RUNNING';

ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_chk" CHECK (
  jsonb_typeof("skipped") = 'array' AND (("status" = 'RUNNING') = ("finished_at" IS NULL)));

ALTER TABLE "collection_drafts" ADD CONSTRAINT "collection_drafts_chk" CHECK (
  jsonb_typeof("facts") = 'object' AND jsonb_typeof("risk_reasons") = 'array' AND jsonb_typeof("checks") = 'array' AND jsonb_typeof("send_log") = 'array'
  AND position('@' in "to_email") > 1
  AND ("risk" IS NULL OR "risk" IN ('LOW', 'MEDIUM', 'HIGH'))
  -- Written drafts have the model's words; failed ones say why.
  AND ("status" IN ('DRAFTING', 'FAILED') OR ("ai_subject" IS NOT NULL AND "ai_body" IS NOT NULL AND "subject" IS NOT NULL AND "body" IS NOT NULL AND "risk" IS NOT NULL))
  AND ("status" <> 'FAILED' OR "error_message" IS NOT NULL)
  -- A person decided every draft that was sent, failed to send or was rejected.
  AND (("status" IN ('SENT', 'SEND_FAILED', 'REJECTED')) = ("decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL))
  AND (("status" = 'SENT') = ("sent_at" IS NOT NULL))
  AND ("status" NOT IN ('SENT', 'SEND_FAILED') OR "send_attempts" >= 1)
  AND "send_attempts" BETWEEN 0 AND 20);

-- A run only finishes; a draft keeps what the model was given and wrote, and a sent or
-- rejected draft never changes. Neither is ever deleted.
CREATE OR REPLACE FUNCTION t2t_guard_collection_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A collections run cannot be removed' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status = 'DONE' THEN RAISE EXCEPTION 'A finished collections run cannot be changed' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.started_by_id <> OLD.started_by_id OR NEW.created_at <> OLD.created_at OR NEW.model <> OLD.model THEN
    RAISE EXCEPTION 'A collections run keeps who started it and when' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collection_runs_guard BEFORE UPDATE OR DELETE ON "collection_runs" FOR EACH ROW EXECUTE FUNCTION t2t_guard_collection_run();

CREATE OR REPLACE FUNCTION t2t_guard_collection_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A reminder draft cannot be removed; reject it instead' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status IN ('SENT', 'REJECTED', 'FAILED') THEN RAISE EXCEPTION 'A sent, rejected or failed reminder cannot be changed' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.run_id <> OLD.run_id OR NEW.contact_id <> OLD.contact_id OR NEW.to_email <> OLD.to_email OR NEW.facts <> OLD.facts
     OR NEW.model <> OLD.model OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A reminder keeps the customer, address and facts it was written for' USING ERRCODE = 'P0001';
  END IF;
  -- What the model wrote is written once.
  IF OLD.status <> 'DRAFTING' AND (NEW.ai_subject IS DISTINCT FROM OLD.ai_subject OR NEW.ai_body IS DISTINCT FROM OLD.ai_body OR NEW.risk IS DISTINCT FROM OLD.risk
     OR NEW.risk_reasons <> OLD.risk_reasons OR NEW.served_model IS DISTINCT FROM OLD.served_model) THEN
    RAISE EXCEPTION 'What the AI model wrote cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'DRAFTING' AND NEW.status NOT IN ('DRAFTING', 'READY', 'FAILED') THEN RAISE EXCEPTION 'A draft is written before it is decided' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status = 'SEND_FAILED' AND NEW.status NOT IN ('SEND_FAILED', 'SENT') THEN RAISE EXCEPTION 'A reminder that failed to send can only be sent again' USING ERRCODE = 'P0001'; END IF;
  IF NEW.send_attempts < OLD.send_attempts THEN RAISE EXCEPTION 'Send attempts only go up' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collection_drafts_guard BEFORE UPDATE OR DELETE ON "collection_drafts" FOR EACH ROW EXECUTE FUNCTION t2t_guard_collection_draft();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['collection_runs', 'collection_drafts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
