-- Ownership share of each group member, for non-controlling interests.
ALTER TABLE "consolidation_members" ADD COLUMN "ownership_percent" DECIMAL(7,4) NOT NULL DEFAULT 100;
ALTER TABLE "consolidation_members" ADD CONSTRAINT "consolidation_members_ownership_check"
  CHECK ("ownership_percent" > 0 AND "ownership_percent" <= 100);
-- The parent always owns itself in full.
ALTER TABLE "consolidation_members" ADD CONSTRAINT "consolidation_members_parent_full_check"
  CHECK ("member_org_id" <> "org_id" OR "ownership_percent" = 100);
