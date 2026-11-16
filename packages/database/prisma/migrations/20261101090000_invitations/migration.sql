-- M1 hardening: member invitations, and protection for an organisation's last owner.

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_by_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_org_id_created_at_idx" ON "invitations"("org_id", "created_at");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;



ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_fk" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id");
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_fk" FOREIGN KEY ("accepted_by_id") REFERENCES "users"("id");
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_revoked_by_fk" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id");
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_email_ck" CHECK (email = lower(email) AND position('@' in email) > 1);
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_state_ck" CHECK (
  NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)
  AND (accepted_at IS NULL) = (accepted_by_id IS NULL)
  AND (revoked_at IS NULL) = (revoked_by_id IS NULL)
  AND expires_at > created_at);
-- One open invitation per organisation and address.
CREATE UNIQUE INDEX "invitations_one_open" ON "invitations"("org_id", "email") WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Accepted or revoked invitations are history: frozen. Open ones may only get a new token
-- and expiry (a fresh link). Invitations are never deleted.
CREATE OR REPLACE FUNCTION t2t_invitations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Invitations cannot be deleted; revoke them instead' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation is already %', CASE WHEN OLD.accepted_at IS NOT NULL THEN 'accepted' ELSE 'revoked' END USING ERRCODE = 'P0001';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.email <> OLD.email OR NEW.role <> OLD.role OR NEW.invited_by_id <> OLD.invited_by_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Invitation email, role and organisation cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invitations_guard BEFORE UPDATE OR DELETE ON "invitations"
  FOR EACH ROW EXECUTE FUNCTION t2t_invitations_guard();

-- Row-level security, like every other tenant table.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitations
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());

-- An organisation always keeps at least one owner.
CREATE OR REPLACE FUNCTION t2t_memberships_last_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'OWNER' AND (TG_OP = 'DELETE' OR NEW.role <> 'OWNER' OR NEW.org_id <> OLD.org_id) THEN
    -- Serialise owner changes per organisation so two owners cannot demote each other at once.
    PERFORM 1 FROM organizations WHERE id = OLD.org_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) AND NOT EXISTS (
      SELECT 1 FROM memberships WHERE org_id = OLD.org_id AND role = 'OWNER' AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'An organisation must keep at least one owner' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER memberships_last_owner BEFORE UPDATE OR DELETE ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION t2t_memberships_last_owner();
