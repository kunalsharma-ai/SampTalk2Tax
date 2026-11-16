



























































































-- CreateTable
CREATE TABLE "twin_scenarios" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "baseline_months" INTEGER NOT NULL,
    "horizon_months" INTEGER NOT NULL,
    "drivers" JSONB NOT NULL,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "twin_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "twin_scenarios_org_id_idx" ON "twin_scenarios"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "twin_scenarios_org_id_name_key" ON "twin_scenarios"("org_id", "name");

-- AddForeignKey
ALTER TABLE "twin_scenarios" ADD CONSTRAINT "twin_scenarios_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "twin_scenarios" ADD CONSTRAINT "twin_scenarios_checks" CHECK (
  length(btrim("name")) > 0
  AND "baseline_months" IN (3, 6, 12)
  AND "horizon_months" BETWEEN 1 AND 60
  AND jsonb_typeof("drivers") = 'array'
  AND jsonb_array_length("drivers") <= 50
);

ALTER TABLE "twin_scenarios" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "twin_scenarios" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "twin_scenarios" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
