-- CreateEnum
CREATE TYPE "CopilotRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "CopilotMessageStatus" AS ENUM ('PENDING', 'COMPLETE', 'REFUSED', 'INCOMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "copilot_settings" (
    "org_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "copilot_settings_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "copilot_conversations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "toolset_version" INTEGER NOT NULL,
    "system_prompt" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_messages" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" "CopilotRole" NOT NULL,
    "status" "CopilotMessageStatus" NOT NULL,
    "text" TEXT,
    "api_messages" JSONB NOT NULL DEFAULT '[]',
    "sources" JSONB NOT NULL DEFAULT '[]',
    "error_code" VARCHAR(60),
    "error_message" VARCHAR(1000),
    "served_model" VARCHAR(100),
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cache_read_tokens" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "copilot_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "copilot_conversations_org_id_user_id_updated_at_idx" ON "copilot_conversations"("org_id", "user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "copilot_conversations_id_org_id_key" ON "copilot_conversations"("id", "org_id");

-- CreateIndex
CREATE INDEX "copilot_messages_org_id_status_idx" ON "copilot_messages"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "copilot_messages_conversation_id_seq_key" ON "copilot_messages"("conversation_id", "seq");

-- AddForeignKey
ALTER TABLE "copilot_settings" ADD CONSTRAINT "copilot_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_conversations" ADD CONSTRAINT "copilot_conversations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_messages" ADD CONSTRAINT "copilot_messages_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_messages" ADD CONSTRAINT "copilot_messages_conversation_id_org_id_fkey" FOREIGN KEY ("conversation_id", "org_id") REFERENCES "copilot_conversations"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------- hand-written

ALTER TABLE "copilot_conversations" ADD CONSTRAINT "copilot_conversations_chk" CHECK (
  length(btrim("title")) > 0 AND length("model") > 0 AND "toolset_version" > 0 AND length("system_prompt") > 0
  AND "updated_at" >= "created_at");

ALTER TABLE "copilot_messages" ADD CONSTRAINT "copilot_messages_chk" CHECK (
  "seq" >= 1
  AND jsonb_typeof("api_messages") = 'array' AND jsonb_typeof("sources") = 'array'
  -- A question is stored whole when it is asked.
  AND ("role" <> 'USER' OR ("status" = 'COMPLETE' AND "text" IS NOT NULL AND length(btrim("text")) > 0))
  AND ("role" = 'USER' OR (("status" = 'PENDING') = ("completed_at" IS NULL)))
  AND ("status" <> 'FAILED' OR "error_code" IS NOT NULL)
  AND ("status" <> 'COMPLETE' OR "role" = 'USER' OR "text" IS NOT NULL)
  AND coalesce("input_tokens", 0) >= 0 AND coalesce("output_tokens", 0) >= 0 AND coalesce("cache_read_tokens", 0) >= 0);

-- A question is never changed. An answer starts pending, is finished once, and is then never changed.
CREATE OR REPLACE FUNCTION t2t_guard_copilot_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.role = 'ASSISTANT' AND NEW.status <> 'PENDING' THEN RAISE EXCEPTION 'A copilot answer starts pending' USING ERRCODE = 'P0001'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING' THEN RAISE EXCEPTION 'A finished copilot message cannot be changed' USING ERRCODE = 'P0001'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.conversation_id <> OLD.conversation_id OR NEW.seq <> OLD.seq OR NEW.role <> OLD.role OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A copilot message keeps its conversation, place and role' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER copilot_messages_guard BEFORE INSERT OR UPDATE ON "copilot_messages" FOR EACH ROW EXECUTE FUNCTION t2t_guard_copilot_message();

CREATE OR REPLACE FUNCTION t2t_guard_copilot_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id <> OLD.org_id OR NEW.user_id <> OLD.user_id OR NEW.model <> OLD.model OR NEW.toolset_version <> OLD.toolset_version OR NEW.system_prompt <> OLD.system_prompt OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A copilot conversation keeps its owner, model and instructions' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER copilot_conversations_guard BEFORE UPDATE ON "copilot_conversations" FOR EACH ROW EXECUTE FUNCTION t2t_guard_copilot_conversation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['copilot_settings', 'copilot_conversations', 'copilot_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;

-- Conversations are private to the member who started it, also within the organisation.
CREATE POLICY owner_only ON "copilot_conversations" AS RESTRICTIVE
  USING (t2t_rls_bypass() OR user_id = t2t_current_user())
  WITH CHECK (t2t_rls_bypass() OR user_id = t2t_current_user());
-- A message is visible only through a conversation the member can see.
CREATE POLICY owner_only ON "copilot_messages" AS RESTRICTIVE
  USING (t2t_rls_bypass() OR EXISTS (SELECT 1 FROM "copilot_conversations" c WHERE c.id = copilot_messages.conversation_id AND c.org_id = copilot_messages.org_id))
  WITH CHECK (t2t_rls_bypass() OR EXISTS (SELECT 1 FROM "copilot_conversations" c WHERE c.id = copilot_messages.conversation_id AND c.org_id = copilot_messages.org_id));
