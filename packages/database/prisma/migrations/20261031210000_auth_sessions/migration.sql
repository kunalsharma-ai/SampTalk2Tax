-- M1 hardening: server-side sessions (refresh tokens, revocation) and sign-in lockout.

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "previous_secret_hash" TEXT,
    "rotated_at" TIMESTAMPTZ(6),
    "rotation_count" INTEGER NOT NULL DEFAULT 0,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_throttles" (
    "email" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "first_failure_at" TIMESTAMPTZ(6) NOT NULL,
    "locked_until" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "login_throttles_pkey" PRIMARY KEY ("email")
);

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_revoked_at_idx" ON "auth_sessions"("user_id", "revoked_at");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity: a session can be revoked once and never revived; its user never changes.
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_revocation_ck"
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL));
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_expiry_ck" CHECK (expires_at > created_at);
ALTER TABLE "login_throttles" ADD CONSTRAINT "login_throttles_failures_ck" CHECK (failures >= 0);

CREATE OR REPLACE FUNCTION t2t_auth_sessions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A session cannot change its user' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.secret_hash <> OLD.secret_hash) THEN
    RAISE EXCEPTION 'A revoked session cannot be used again' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'A session cannot be extended past its hard expiry' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_sessions_guard BEFORE UPDATE ON "auth_sessions"
  FOR EACH ROW EXECUTE FUNCTION t2t_auth_sessions_guard();
