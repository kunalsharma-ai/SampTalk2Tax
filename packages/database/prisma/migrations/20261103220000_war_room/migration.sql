-- CreateEnum
CREATE TYPE "ScenarioStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "twin_scenarios" ADD COLUMN     "decided_at" TIMESTAMPTZ(6),
ADD COLUMN     "decided_by_id" UUID,
ADD COLUMN     "decision_note" VARCHAR(1000),
ADD COLUMN     "status" "ScenarioStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "submitted_at" TIMESTAMPTZ(6),
ADD COLUMN     "submitted_by_id" UUID,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "twin_scenario_versions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "baseline_months" INTEGER NOT NULL,
    "horizon_months" INTEGER NOT NULL,
    "drivers" JSONB NOT NULL,
    "reason" VARCHAR(40) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "twin_scenario_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "twin_scenario_notes" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "month" INTEGER,
    "change_number" INTEGER,
    "body" VARCHAR(2000) NOT NULL,
    "author_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "twin_scenario_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "twin_scenario_versions_org_id_idx" ON "twin_scenario_versions"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "twin_scenario_versions_scenario_id_version_key" ON "twin_scenario_versions"("scenario_id", "version");

-- CreateIndex
CREATE INDEX "twin_scenario_notes_org_id_idx" ON "twin_scenario_notes"("org_id");

-- CreateIndex
CREATE INDEX "twin_scenario_notes_scenario_id_idx" ON "twin_scenario_notes"("scenario_id");

-- AddForeignKey
ALTER TABLE "twin_scenario_versions" ADD CONSTRAINT "twin_scenario_versions_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "twin_scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "twin_scenario_notes" ADD CONSTRAINT "twin_scenario_notes_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "twin_scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Organisation keys and checks.
ALTER TABLE "twin_scenario_versions" ADD CONSTRAINT "twin_scenario_versions_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "twin_scenario_notes" ADD CONSTRAINT "twin_scenario_notes_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "twin_scenarios_id_org_key" ON "twin_scenarios"("id", "org_id");
ALTER TABLE "twin_scenario_versions" ADD CONSTRAINT "twin_scenario_versions_same_org_fk" FOREIGN KEY ("scenario_id", "org_id") REFERENCES "twin_scenarios"("id", "org_id") ON DELETE CASCADE;
ALTER TABLE "twin_scenario_notes" ADD CONSTRAINT "twin_scenario_notes_same_org_fk" FOREIGN KEY ("scenario_id", "org_id") REFERENCES "twin_scenarios"("id", "org_id") ON DELETE CASCADE;

ALTER TABLE "twin_scenarios" ADD CONSTRAINT "twin_scenarios_status_checks" CHECK (
  "version" >= 1
  AND ("status" = 'DRAFT' OR ("submitted_by_id" IS NOT NULL AND "submitted_at" IS NOT NULL))
  AND (("status" IN ('APPROVED', 'REJECTED')) = ("decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL))
  AND ("status" <> 'REJECTED' OR "decision_note" IS NOT NULL)
);
ALTER TABLE "twin_scenario_versions" ADD CONSTRAINT "twin_scenario_versions_checks" CHECK (
  "version" >= 1
  AND "baseline_months" IN (3, 6, 12)
  AND "horizon_months" BETWEEN 1 AND 60
  AND jsonb_typeof("drivers") = 'array'
  AND jsonb_array_length("drivers") <= 50
);
ALTER TABLE "twin_scenario_notes" ADD CONSTRAINT "twin_scenario_notes_checks" CHECK (
  length(btrim("body")) > 0
  AND "version" >= 1
  AND ("month" IS NULL OR "month" BETWEEN 1 AND 60)
  AND ("change_number" IS NULL OR "change_number" BETWEEN 1 AND 50)
  AND (("resolved_by_id" IS NULL) = ("resolved_at" IS NULL))
);

-- Versions are history: never changed once written.
CREATE OR REPLACE FUNCTION t2t_twin_versions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Scenario versions cannot be changed' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER twin_scenario_versions_immutable BEFORE UPDATE ON "twin_scenario_versions" FOR EACH ROW EXECUTE FUNCTION t2t_twin_versions_immutable();

ALTER TABLE "twin_scenario_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "twin_scenario_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "twin_scenario_versions" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "twin_scenario_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "twin_scenario_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "twin_scenario_notes" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());

-- Existing scenarios start their history at version 1.
SELECT set_config('t2t.bypass', 'on', true);
INSERT INTO "twin_scenario_versions" ("id", "org_id", "scenario_id", "version", "name", "description", "baseline_months", "horizon_months", "drivers", "reason", "created_by_id", "created_at")
SELECT gen_random_uuid(), "org_id", "id", 1, "name", "description", "baseline_months", "horizon_months", "drivers", 'CREATED', "updated_by_id", "updated_at" FROM "twin_scenarios";
