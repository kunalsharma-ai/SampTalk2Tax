-- Financial recovery planner (M7 slice 3): plans and the actions taken into them.
-- Plans only record what people decide; nothing here posts, pays or borrows.

-- CreateEnum
CREATE TYPE "RecoveryActionStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'DONE', 'DROPPED');

-- CreateEnum
CREATE TYPE "RecoveryPlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');

-- CreateTable
CREATE TABLE "recovery_plans" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "status" "RecoveryPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "baseline_months" INTEGER NOT NULL,
    "horizon_months" INTEGER NOT NULL,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "recovery_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_actions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "option_key" VARCHAR(40) NOT NULL,
    "category" VARCHAR(30) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "detail" VARCHAR(2000) NOT NULL,
    "drivers" JSONB NOT NULL,
    "targets" JSONB NOT NULL,
    "risks" JSONB NOT NULL,
    "needs_decision" BOOLEAN NOT NULL,
    "status" "RecoveryActionStatus" NOT NULL DEFAULT 'PLANNED',
    "owner_id" UUID,
    "due_date" DATE,
    "note" VARCHAR(2000),
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recovery_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recovery_plans_org_id_idx" ON "recovery_plans"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_plans_org_id_name_key" ON "recovery_plans"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_plans_id_org_key" ON "recovery_plans"("id", "org_id");

-- CreateIndex
CREATE INDEX "recovery_actions_org_id_idx" ON "recovery_actions"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_actions_plan_id_option_key_key" ON "recovery_actions"("plan_id", "option_key");

-- AddForeignKey
ALTER TABLE "recovery_plans" ADD CONSTRAINT "recovery_plans_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "recovery_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An action belongs to a plan of the same organisation.
ALTER TABLE "recovery_actions" DROP CONSTRAINT "recovery_actions_plan_id_fkey";
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_plan_org_fkey" FOREIGN KEY ("plan_id", "org_id") REFERENCES "recovery_plans"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recovery_plans" ADD CONSTRAINT "recovery_plans_months_check" CHECK ("baseline_months" IN (3, 6, 12) AND "horizon_months" BETWEEN 1 AND 60);
ALTER TABLE "recovery_plans" ADD CONSTRAINT "recovery_plans_closed_check" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL));
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_json_check" CHECK (jsonb_typeof("drivers") = 'array' AND jsonb_typeof("targets") = 'array' AND jsonb_typeof("risks") = 'array');
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_category_check" CHECK ("category" IN ('COLLECTIONS', 'CASH_CONSERVATION', 'EXPENSES', 'SUPPLIERS', 'FINANCING', 'REVENUE', 'RESTRUCTURING'));

ALTER TABLE "recovery_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recovery_plans" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "recovery_plans" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "recovery_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recovery_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "recovery_actions" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
