-- CreateEnum
CREATE TYPE "DecisionStatus" AS ENUM ('ACTIVE', 'REVIEWED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "decisions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "decision" VARCHAR(4000) NOT NULL,
    "context" VARCHAR(4000),
    "category" VARCHAR(20) NOT NULL,
    "tags" TEXT[],
    "decided_on" DATE NOT NULL,
    "decided_by" VARCHAR(200),
    "review_due" DATE,
    "assumptions" JSONB NOT NULL,
    "outcomes" JSONB NOT NULL,
    "source_type" VARCHAR(20),
    "source_id" UUID,
    "status" "DecisionStatus" NOT NULL DEFAULT 'ACTIVE',
    "verdict" VARCHAR(20),
    "outcome_notes" VARCHAR(4000),
    "lessons" VARCHAR(4000),
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "withdrawn_reason" VARCHAR(1000),
    "withdrawn_by_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decisions_org_id_status_idx" ON "decisions"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "decisions_org_id_number_key" ON "decisions"("org_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "decisions_id_org_key" ON "decisions"("id", "org_id");

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "decisions" ADD CONSTRAINT "decisions_category_check" CHECK ("category" IN ('PRICING', 'HIRING', 'COSTS', 'INVESTMENT', 'FUNDING', 'CREDIT', 'SUPPLIERS', 'GROWTH', 'OTHER'));
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_source_check" CHECK (("source_type" IS NULL AND "source_id" IS NULL) OR ("source_type" IN ('SCENARIO', 'RECOVERY_PLAN') AND "source_id" IS NOT NULL));
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_json_check" CHECK (jsonb_typeof("assumptions") = 'array' AND jsonb_typeof("outcomes") = 'array');
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_status_check" CHECK (
  ("status" = 'ACTIVE' AND "verdict" IS NULL AND "reviewed_at" IS NULL AND "withdrawn_at" IS NULL)
  OR ("status" = 'REVIEWED' AND "verdict" IN ('WORKED', 'PARTLY', 'DID_NOT_WORK') AND "reviewed_at" IS NOT NULL AND "reviewed_by_id" IS NOT NULL AND "withdrawn_at" IS NULL)
  OR ("status" = 'WITHDRAWN' AND "verdict" IS NULL AND "withdrawn_at" IS NOT NULL AND "withdrawn_by_id" IS NOT NULL AND "withdrawn_reason" IS NOT NULL));

-- A reviewed or withdrawn decision is part of the record: it can no longer be changed or deleted.
CREATE FUNCTION t2t_decisions_final_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'decision % is % and cannot be changed', OLD.number, lower(OLD.status::text) USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER decisions_final_guard BEFORE UPDATE OR DELETE ON "decisions" FOR EACH ROW EXECUTE FUNCTION t2t_decisions_final_guard();

ALTER TABLE "decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "decisions" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
