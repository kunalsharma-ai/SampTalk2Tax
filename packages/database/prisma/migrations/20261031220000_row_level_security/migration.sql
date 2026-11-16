-- M1 hardening: PostgreSQL row-level security as a second tenant-isolation layer.
--
-- The API sets three transaction-local settings before every statement
-- (apps/api/src/common/prisma.service.ts):
--   t2t.org_id   the organisation the request is scoped to (after the membership check)
--   t2t.user_id  the signed-in user
--   t2t.bypass   'on' only for system work (seed, migrations scripts, global audit chain)
-- With no settings, tenant tables return no rows and accept no writes.
-- FORCE makes the policies apply to the table owner too, which is the role the API uses.

CREATE OR REPLACE FUNCTION t2t_current_org() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('t2t.org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION t2t_current_user() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('t2t.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION t2t_rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(current_setting('t2t.bypass', true), '') = 'on' $$;

-- Tables whose rows belong to exactly one organisation through org_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'accounts', 'allocations', 'approval_policies', 'approval_requests', 'attachments',
    'bank_matches', 'bank_reconciliations', 'bank_statement_imports', 'bank_statement_lines',
    'contacts', 'document_lines', 'documents', 'expense_claim_lines', 'expense_claims',
    'fiscal_periods', 'journal_entries', 'journal_lines', 'org_counters', 'payments', 'tax_rates'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())',
      t);
  END LOOP;
END $$;

-- Audit events: an organisation's chain is visible in that organisation; the global chain
-- (sign-ins, sessions; org_id NULL) only to system work.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());

-- Memberships: a user sees their own memberships (to list their organisations) and, inside
-- an organisation, its members. Writes only inside the organisation.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (t2t_rls_bypass() OR org_id = t2t_current_org() OR user_id = t2t_current_user())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());

-- Organisations: the current one, and the ones the user belongs to (names in the switcher).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
  USING (
    t2t_rls_bypass()
    OR id = t2t_current_org()
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = organizations.id AND m.user_id = t2t_current_user())
  )
  WITH CHECK (t2t_rls_bypass() OR id = t2t_current_org());

-- users, auth_sessions and login_throttles are not tenant data and are not covered;
-- the API only reaches them by the signed-in user's id or by email at sign-in.
