-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('AI_ANTHROPIC', 'EMAIL_SMTP');

-- CreateEnum
CREATE TYPE "IntegrationTestStatus" AS ENUM ('NOT_TESTED', 'OK', 'FAILED');

-- CreateTable
CREATE TABLE "org_integrations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL,
    "secret_cipher" TEXT,
    "key_id" VARCHAR(16),
    "secret_hint" VARCHAR(16),
    "test_status" "IntegrationTestStatus" NOT NULL DEFAULT 'NOT_TESTED',
    "test_message" VARCHAR(500),
    "tested_at" TIMESTAMPTZ(6),
    "tested_by_id" UUID,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "org_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_integrations_org_id_idx" ON "org_integrations"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_integrations_org_id_kind_key" ON "org_integrations"("org_id", "kind");

-- AddForeignKey
ALTER TABLE "org_integrations" ADD CONSTRAINT "org_integrations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "org_integrations" ADD CONSTRAINT "org_integrations_checks" CHECK (
  jsonb_typeof("settings") = 'object'
  AND (("secret_cipher" IS NULL) = ("key_id" IS NULL))
  AND (("tested_at" IS NULL) = ("test_status" = 'NOT_TESTED'))
);

ALTER TABLE "org_integrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_integrations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "org_integrations" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
