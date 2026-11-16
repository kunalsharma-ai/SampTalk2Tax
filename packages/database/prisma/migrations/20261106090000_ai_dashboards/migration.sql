-- CreateTable
CREATE TABLE "dashboards" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "config" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_ai_drafts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "request" VARCHAR(8000) NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "result" JSONB,
    "error_code" VARCHAR(40),
    "error_message" VARCHAR(500),
    "model" VARCHAR(100),
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dashboard_ai_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dashboards_org_id_number_key" ON "dashboards"("org_id", "number");
CREATE UNIQUE INDEX "dashboards_org_id_name_key" ON "dashboards"("org_id", "name");
CREATE INDEX "dashboard_ai_drafts_org_id_created_at_idx" ON "dashboard_ai_drafts"("org_id", "created_at");

-- AddForeignKey
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dashboard_ai_drafts" ADD CONSTRAINT "dashboard_ai_drafts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_config_check" CHECK (jsonb_typeof("config") = 'object' AND jsonb_typeof("config"->'widgets') = 'array' AND jsonb_array_length("config"->'widgets') BETWEEN 1 AND 12);
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_version_check" CHECK ("version" >= 1 AND "number" >= 1);
ALTER TABLE "dashboard_ai_drafts" ADD CONSTRAINT "dashboard_ai_drafts_status_check" CHECK ("status" IN ('DONE', 'FAILED'));

ALTER TABLE "dashboards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboards" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dashboards" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "dashboard_ai_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_ai_drafts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dashboard_ai_drafts" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
