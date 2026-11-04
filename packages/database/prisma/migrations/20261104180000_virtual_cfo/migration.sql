-- Virtual CFO: board packs and investor updates, and the CFO agent in the AI control center.

-- AlterEnum
ALTER TYPE "AiAgent" ADD VALUE 'CFO';

-- CreateEnum
CREATE TYPE "CfoReportKind" AS ENUM ('BOARD', 'INVESTOR');

-- CreateEnum
CREATE TYPE "CfoReportStatus" AS ENUM ('DRAFT', 'FINAL');

-- CreateEnum
CREATE TYPE "CfoAiStatus" AS ENUM ('NONE', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "cfo_reports" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" "CfoReportKind" NOT NULL,
    "month" CHAR(7) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "status" "CfoReportStatus" NOT NULL DEFAULT 'DRAFT',
    "snapshot" JSONB NOT NULL,
    "facts" TEXT NOT NULL,
    "commentary" VARCHAR(10000),
    "ai_status" "CfoAiStatus" NOT NULL DEFAULT 'NONE',
    "ai_summary" VARCHAR(6000),
    "ai_model" VARCHAR(100),
    "served_model" VARCHAR(100),
    "ai_error_code" VARCHAR(60),
    "ai_error_message" VARCHAR(1000),
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "ai_started_by_id" UUID,
    "ai_started_at" TIMESTAMPTZ(6),
    "ai_finished_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "finalised_by_id" UUID,
    "finalised_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cfo_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cfo_reports_org_id_idx" ON "cfo_reports"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "cfo_reports_org_id_kind_month_key" ON "cfo_reports"("org_id", "kind", "month");

-- AddForeignKey
ALTER TABLE "cfo_reports" ADD CONSTRAINT "cfo_reports_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cfo_reports" ADD CONSTRAINT "cfo_reports_month_check" CHECK ("month" ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "cfo_reports" ADD CONSTRAINT "cfo_reports_final_check" CHECK (("status" = 'FINAL') = ("finalised_at" IS NOT NULL AND "finalised_by_id" IS NOT NULL));
ALTER TABLE "cfo_reports" ADD CONSTRAINT "cfo_reports_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object');
-- An AI summary is only kept once it has passed the figure check.
ALTER TABLE "cfo_reports" ADD CONSTRAINT "cfo_reports_ai_check" CHECK (("ai_summary" IS NULL) OR ("ai_status" = 'DONE'));

-- A final pack is a record: it cannot be changed or deleted.
CREATE FUNCTION cfo_reports_final_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'FINAL' THEN
    RAISE EXCEPTION 'A final CFO report cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER cfo_reports_final_guard BEFORE UPDATE OR DELETE ON "cfo_reports" FOR EACH ROW EXECUTE FUNCTION cfo_reports_final_guard();

ALTER TABLE "cfo_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cfo_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cfo_reports" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
