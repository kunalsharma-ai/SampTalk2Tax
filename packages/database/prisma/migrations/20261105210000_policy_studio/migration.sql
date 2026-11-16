-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "statement" VARCHAR(4000) NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "version" INTEGER NOT NULL,
    "active_version" INTEGER,
    "rules" JSONB NOT NULL,
    "tests" JSONB NOT NULL,
    "workflow_ids" UUID[],
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_versions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "statement" VARCHAR(4000) NOT NULL,
    "rules" JSONB NOT NULL,
    "tests" JSONB NOT NULL,
    "event" VARCHAR(10) NOT NULL,
    "note" VARCHAR(1000),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_ai_drafts" (
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

    CONSTRAINT "policy_ai_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "policies_org_id_number_key" ON "policies"("org_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "policies_org_id_name_key" ON "policies"("org_id", "name");

-- CreateIndex
CREATE INDEX "policy_versions_org_id_policy_id_version_idx" ON "policy_versions"("org_id", "policy_id", "version");

-- CreateIndex
CREATE INDEX "policy_ai_drafts_org_id_created_at_idx" ON "policy_ai_drafts"("org_id", "created_at");

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_ai_drafts" ADD CONSTRAINT "policy_ai_drafts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A version belongs to a policy of the same organisation.
CREATE UNIQUE INDEX "policies_org_id_id_key" ON "policies"("org_id", "id");
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_org_fkey" FOREIGN KEY ("org_id", "policy_id") REFERENCES "policies"("org_id", "id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "policy_versions_policy_version_event_key" ON "policy_versions"("policy_id", "version", "event");

ALTER TABLE "policies" ADD CONSTRAINT "policies_status_check" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'RETIRED'));
ALTER TABLE "policies" ADD CONSTRAINT "policies_version_check" CHECK ("version" >= 1 AND ("active_version" IS NULL OR "active_version" BETWEEN 1 AND "version"));
ALTER TABLE "policies" ADD CONSTRAINT "policies_active_check" CHECK ("status" <> 'ACTIVE' OR "active_version" = "version");
ALTER TABLE "policies" ADD CONSTRAINT "policies_json_check" CHECK (jsonb_typeof("rules") = 'array' AND jsonb_typeof("tests") = 'array');
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_event_check" CHECK ("event" IN ('CREATED', 'EDITED', 'APPROVED', 'RETIRED'));
ALTER TABLE "policy_ai_drafts" ADD CONSTRAINT "policy_ai_drafts_status_check" CHECK ("status" IN ('DONE', 'FAILED'));

-- Versions are the policy's history: never changed or deleted.
CREATE FUNCTION t2t_policy_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'policy versions cannot be changed or deleted' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER policy_versions_immutable BEFORE UPDATE OR DELETE ON "policy_versions" FOR EACH ROW EXECUTE FUNCTION t2t_policy_versions_immutable();

ALTER TABLE "policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "policies" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "policy_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "policy_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "policy_versions" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "policy_ai_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "policy_ai_drafts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "policy_ai_drafts" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
