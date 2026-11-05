-- CreateTable
CREATE TABLE "disaster_simulations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "baseline_months" INTEGER NOT NULL,
    "horizon_months" INTEGER NOT NULL,
    "shocks" JSONB NOT NULL,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "disaster_simulations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "disaster_simulations_org_id_number_key" ON "disaster_simulations"("org_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "disaster_simulations_org_id_name_key" ON "disaster_simulations"("org_id", "name");

-- AddForeignKey
ALTER TABLE "disaster_simulations" ADD CONSTRAINT "disaster_simulations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "disaster_simulations" ADD CONSTRAINT "disaster_simulations_months_check" CHECK ("baseline_months" IN (3, 6, 12) AND "horizon_months" BETWEEN 1 AND 60);
ALTER TABLE "disaster_simulations" ADD CONSTRAINT "disaster_simulations_shocks_check" CHECK (jsonb_typeof("shocks") = 'array' AND jsonb_array_length("shocks") BETWEEN 1 AND 10);
ALTER TABLE "disaster_simulations" ADD CONSTRAINT "disaster_simulations_name_check" CHECK (length(btrim("name")) > 0);

ALTER TABLE "disaster_simulations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "disaster_simulations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "disaster_simulations" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
