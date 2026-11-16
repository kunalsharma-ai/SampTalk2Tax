-- AI control center: per-agent switches and monthly token budgets, and the reason AI was stopped.

-- CreateEnum
CREATE TYPE "AiAgent" AS ENUM ('COPILOT', 'COLLECTIONS', 'BANKING', 'CLOSE');

-- AlterTable
ALTER TABLE "copilot_settings" ADD COLUMN     "off_reason" VARCHAR(500);
ALTER TABLE "copilot_settings" ADD CONSTRAINT "copilot_settings_off_reason_chk" CHECK (off_reason IS NULL OR (NOT enabled AND length(btrim(off_reason)) >= 10));

-- CreateTable
CREATE TABLE "ai_agent_settings" (
    "org_id" UUID NOT NULL,
    "agent" "AiAgent" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "monthly_token_limit" INTEGER,
    "updated_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_agent_settings_pkey" PRIMARY KEY ("org_id","agent"),
    CONSTRAINT "ai_agent_settings_limit_chk" CHECK (monthly_token_limit IS NULL OR monthly_token_limit BETWEEN 1000 AND 1000000000)
);

-- AddForeignKey
ALTER TABLE "ai_agent_settings" ADD CONSTRAINT "ai_agent_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_agent_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_agent_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ai_agent_settings" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
