-- CreateEnum
CREATE TYPE "BankAiRunStatus" AS ENUM ('RUNNING', 'DONE');

-- CreateEnum
CREATE TYPE "BankAiSuggestionStatus" AS ENUM ('DRAFTING', 'READY', 'ACCEPTED', 'DISMISSED', 'FAILED');

-- CreateEnum
CREATE TYPE "BankAiAction" AS ENUM ('MATCH', 'PAYMENT', 'ENTRY', 'NONE');

-- CreateTable
CREATE TABLE "bank_ai_runs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" "BankAiRunStatus" NOT NULL DEFAULT 'RUNNING',
    "started_by_id" UUID NOT NULL,
    "skipped" JSONB NOT NULL DEFAULT '[]',
    "model" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "bank_ai_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_ai_suggestions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "statement_line_id" UUID NOT NULL,
    "status" "BankAiSuggestionStatus" NOT NULL DEFAULT 'DRAFTING',
    "context" JSONB NOT NULL,
    "action" "BankAiAction",
    "proposal" JSONB,
    "resolved" JSONB,
    "confidence" VARCHAR(10),
    "reason" TEXT,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "model" VARCHAR(100) NOT NULL,
    "served_model" VARCHAR(100),
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "error_code" VARCHAR(40),
    "error_message" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bank_ai_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_ai_runs_org_id_account_id_created_at_idx" ON "bank_ai_runs"("org_id", "account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bank_ai_runs_id_org_id_key" ON "bank_ai_runs"("id", "org_id");

-- CreateIndex
CREATE INDEX "bank_ai_suggestions_org_id_status_created_at_idx" ON "bank_ai_suggestions"("org_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "bank_ai_suggestions_org_id_statement_line_id_idx" ON "bank_ai_suggestions"("org_id", "statement_line_id");

-- AddForeignKey
ALTER TABLE "bank_ai_runs" ADD CONSTRAINT "bank_ai_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_ai_suggestions" ADD CONSTRAINT "bank_ai_suggestions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_ai_suggestions" ADD CONSTRAINT "bank_ai_suggestions_run_id_org_id_fkey" FOREIGN KEY ("run_id", "org_id") REFERENCES "bank_ai_runs"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_ai_suggestions" ADD CONSTRAINT "bank_ai_suggestions_statement_line_id_org_id_fkey" FOREIGN KEY ("statement_line_id", "org_id") REFERENCES "bank_statement_lines"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;



ALTER TABLE "bank_ai_runs" ADD CONSTRAINT "bank_ai_runs_account_id_org_id_fkey" FOREIGN KEY ("account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One AI run at a time per organisation, and one open suggestion per bank line.
CREATE UNIQUE INDEX "bank_ai_runs_one_running" ON "bank_ai_runs"("org_id") WHERE "status" = 'RUNNING';
CREATE UNIQUE INDEX "bank_ai_suggestions_one_open" ON "bank_ai_suggestions"("statement_line_id") WHERE "status" IN ('DRAFTING', 'READY');

ALTER TABLE "bank_ai_runs" ADD CONSTRAINT "bank_ai_runs_chk" CHECK (
  jsonb_typeof("skipped") = 'array' AND (("status" = 'RUNNING') = ("finished_at" IS NULL)));

ALTER TABLE "bank_ai_suggestions" ADD CONSTRAINT "bank_ai_suggestions_chk" CHECK (
  jsonb_typeof("context") = 'object' AND jsonb_typeof("checks") = 'array'
  AND ("confidence" IS NULL OR "confidence" IN ('LOW', 'MEDIUM', 'HIGH'))
  -- A proposal has the model's action, what it sent, a confidence and a reason; failed ones say why.
  AND ("status" IN ('DRAFTING', 'FAILED') OR ("action" IS NOT NULL AND "proposal" IS NOT NULL AND "confidence" IS NOT NULL AND "reason" IS NOT NULL))
  AND ("status" <> 'FAILED' OR "error_message" IS NOT NULL)
  -- Only a proposal that passed its checks, and is not "none", can be accepted, and accepting records what it made.
  AND ("status" <> 'ACCEPTED' OR ("resolved" IS NOT NULL AND "action" <> 'NONE' AND "result" IS NOT NULL))
  AND (("status" IN ('ACCEPTED', 'DISMISSED')) = ("decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL)));

CREATE OR REPLACE FUNCTION t2t_guard_bank_ai_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An AI reconciliation run cannot be removed' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status = 'DONE' THEN RAISE EXCEPTION 'A finished AI reconciliation run cannot be changed' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.account_id <> OLD.account_id OR NEW.started_by_id <> OLD.started_by_id OR NEW.created_at <> OLD.created_at OR NEW.model <> OLD.model THEN
    RAISE EXCEPTION 'An AI reconciliation run keeps its account and who started it' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_ai_runs_guard BEFORE UPDATE OR DELETE ON "bank_ai_runs" FOR EACH ROW EXECUTE FUNCTION t2t_guard_bank_ai_run();

-- A suggestion keeps what the model was shown and what it proposed; an accepted, dismissed
-- or failed one never changes; none is ever deleted.
CREATE OR REPLACE FUNCTION t2t_guard_bank_ai_suggestion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An AI bank suggestion cannot be removed; dismiss it instead' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status IN ('ACCEPTED', 'DISMISSED', 'FAILED') THEN RAISE EXCEPTION 'An accepted, dismissed or failed AI bank suggestion cannot be changed' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.run_id <> OLD.run_id OR NEW.statement_line_id <> OLD.statement_line_id OR NEW.context <> OLD.context
     OR NEW.model <> OLD.model OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An AI bank suggestion keeps its line and what the model was shown' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'DRAFTING' AND (NEW.action IS DISTINCT FROM OLD.action OR NEW.proposal IS DISTINCT FROM OLD.proposal OR NEW.resolved IS DISTINCT FROM OLD.resolved
     OR NEW.confidence IS DISTINCT FROM OLD.confidence OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.checks <> OLD.checks OR NEW.served_model IS DISTINCT FROM OLD.served_model) THEN
    RAISE EXCEPTION 'What the AI model proposed cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'DRAFTING' AND NEW.status NOT IN ('DRAFTING', 'READY', 'FAILED') THEN RAISE EXCEPTION 'A suggestion is proposed before it is decided' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_ai_suggestions_guard BEFORE UPDATE OR DELETE ON "bank_ai_suggestions" FOR EACH ROW EXECUTE FUNCTION t2t_guard_bank_ai_suggestion();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_ai_runs', 'bank_ai_suggestions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
