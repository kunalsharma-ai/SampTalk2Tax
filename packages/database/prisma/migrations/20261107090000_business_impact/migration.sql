-- CreateTable
CREATE TABLE "impact_assessments" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "baseline_months" INTEGER NOT NULL,
    "horizon_months" INTEGER NOT NULL,
    "changes" JSONB NOT NULL,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "impact_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "impact_assessments_org_id_number_key" ON "impact_assessments"("org_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "impact_assessments_org_id_name_key" ON "impact_assessments"("org_id", "name");

-- AddForeignKey
ALTER TABLE "impact_assessments" ADD CONSTRAINT "impact_assessments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "impact_assessments" ADD CONSTRAINT "impact_assessments_months_check" CHECK ("baseline_months" IN (3, 6, 12) AND "horizon_months" BETWEEN 1 AND 60);
ALTER TABLE "impact_assessments" ADD CONSTRAINT "impact_assessments_changes_check" CHECK (jsonb_typeof("changes") = 'array' AND jsonb_array_length("changes") BETWEEN 1 AND 15);
ALTER TABLE "impact_assessments" ADD CONSTRAINT "impact_assessments_name_check" CHECK (length(btrim("name")) > 0);

ALTER TABLE "impact_assessments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "impact_assessments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "impact_assessments" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
