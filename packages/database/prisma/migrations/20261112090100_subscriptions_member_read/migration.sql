-- Members see their organisations' subscriptions in the organisation list (like organizations itself).
DROP POLICY tenant_isolation ON "subscriptions";
CREATE POLICY tenant_isolation ON "subscriptions"
  USING (
    t2t_rls_bypass()
    OR org_id = t2t_current_org()
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = subscriptions.org_id AND m.user_id = t2t_current_user())
  )
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
