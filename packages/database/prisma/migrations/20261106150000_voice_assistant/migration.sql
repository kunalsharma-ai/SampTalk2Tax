-- Voice assistant: how each question was asked, and actions the assistant proposes that only
-- happen when the member who asked confirms them.
ALTER TABLE "copilot_messages" ADD COLUMN "channel" VARCHAR(10) NOT NULL DEFAULT 'TEXT';
ALTER TABLE "copilot_messages" ADD CONSTRAINT "copilot_messages_channel_check" CHECK ("channel" IN ('TEXT', 'VOICE'));

CREATE TABLE "copilot_actions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "input" JSONB NOT NULL,
    "summary" VARCHAR(1000) NOT NULL,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(12) NOT NULL DEFAULT 'PROPOSED',
    "result" JSONB,
    "error" VARCHAR(1000),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "copilot_actions_org_id_conversation_id_idx" ON "copilot_actions"("org_id", "conversation_id");
CREATE INDEX "copilot_actions_org_id_user_id_status_idx" ON "copilot_actions"("org_id", "user_id", "status");

ALTER TABLE "copilot_actions" ADD CONSTRAINT "copilot_actions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "copilot_actions" ADD CONSTRAINT "copilot_actions_conversation_id_org_id_fkey" FOREIGN KEY ("conversation_id", "org_id") REFERENCES "copilot_conversations"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "copilot_actions" ADD CONSTRAINT "copilot_actions_kind_check" CHECK ("kind" IN ('CREATE_TASK', 'ACKNOWLEDGE_ALERT', 'DISMISS_ALERT'));
ALTER TABLE "copilot_actions" ADD CONSTRAINT "copilot_actions_status_check" CHECK ("status" IN ('PROPOSED', 'DONE', 'CANCELLED', 'FAILED', 'EXPIRED'));
ALTER TABLE "copilot_actions" ADD CONSTRAINT "copilot_actions_decided_check" CHECK (("status" = 'PROPOSED') = ("decided_at" IS NULL));

-- A decided action is a record: it can never be changed again (it goes only with its conversation).
CREATE OR REPLACE FUNCTION t2t_copilot_actions_decided() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PROPOSED' THEN
    RAISE EXCEPTION 'a decided assistant action cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind OR NEW.input <> OLD.input OR NEW.summary <> OLD.summary OR NEW.conversation_id <> OLD.conversation_id THEN
    RAISE EXCEPTION 'only the decision on an assistant action can be recorded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER copilot_actions_decided BEFORE UPDATE ON "copilot_actions" FOR EACH ROW EXECUTE FUNCTION t2t_copilot_actions_decided();

ALTER TABLE "copilot_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "copilot_actions" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
