-- CreateEnum
CREATE TYPE "BenchmarkStatus" AS ENUM ('OPTED_IN', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "benchmark_participations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "status" "BenchmarkStatus" NOT NULL,
    "industry" TEXT NOT NULL,
    "size_band" TEXT NOT NULL,
    "headcount" INTEGER,
    "shared_metrics" TEXT[] NOT NULL,
    "consent_version" INTEGER NOT NULL,
    "participant_key" UUID,
    "contributed_period" CHAR(7),
    "contributed_at" TIMESTAMPTZ(6),
    "consented_by_id" UUID NOT NULL,
    "consented_at" TIMESTAMPTZ(6) NOT NULL,
    "withdrawn_by_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "benchmark_participations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benchmark_contributions" (
    "id" UUID NOT NULL,
    "participant_key" UUID NOT NULL,
    "period" CHAR(7) NOT NULL,
    "industry" TEXT NOT NULL,
    "size_band" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "is_synthetic" BOOLEAN NOT NULL,
    "metrics" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "benchmark_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_participations_org_id_key" ON "benchmark_participations"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_participations_participant_key_key" ON "benchmark_participations"("participant_key");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_contributions_participant_key_key" ON "benchmark_contributions"("participant_key");

-- CreateIndex
CREATE INDEX "benchmark_contributions_period_is_synthetic_idx" ON "benchmark_contributions"("period", "is_synthetic");

-- AddForeignKey
ALTER TABLE "benchmark_participations" ADD CONSTRAINT "benchmark_participations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "benchmark_participations" ADD CONSTRAINT "benchmark_participations_status_check" CHECK (
  ("status" = 'OPTED_IN' AND "participant_key" IS NOT NULL AND "withdrawn_at" IS NULL)
  OR ("status" = 'WITHDRAWN' AND "participant_key" IS NULL AND "withdrawn_at" IS NOT NULL AND "withdrawn_by_id" IS NOT NULL));
ALTER TABLE "benchmark_participations" ADD CONSTRAINT "benchmark_participations_headcount_check" CHECK ("headcount" IS NULL OR "headcount" BETWEEN 1 AND 10000000);
ALTER TABLE "benchmark_participations" ADD CONSTRAINT "benchmark_participations_period_check" CHECK ("contributed_period" IS NULL OR "contributed_period" ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "benchmark_contributions" ADD CONSTRAINT "benchmark_contributions_period_check" CHECK ("period" ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "benchmark_contributions" ADD CONSTRAINT "benchmark_contributions_metrics_check" CHECK (jsonb_typeof("metrics") = 'object');

ALTER TABLE "benchmark_participations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "benchmark_participations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "benchmark_participations" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());

-- The pool belongs to no tenant: no organisation can read or write it, only the system.
ALTER TABLE "benchmark_contributions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "benchmark_contributions" FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON "benchmark_contributions" USING (t2t_rls_bypass()) WITH CHECK (t2t_rls_bypass());
