-- Error occurrences can carry an organisation's id and text from its request, so they get the
-- same row-level security as tenant tables. Recording and the platform screens use system access.
ALTER TABLE "error_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "error_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "error_events"
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
