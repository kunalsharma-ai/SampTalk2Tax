-- Group consolidation: groups of organisations owned by a parent organisation, their members,
-- translation rates per member and period end, and elimination rules pairing accounts.


-- CreateTable
CREATE TABLE "consolidation_groups" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "consolidation_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidation_members" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "member_org_id" UUID NOT NULL,
    "added_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consolidation_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidation_rates" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "member_org_id" UUID NOT NULL,
    "period_end" DATE NOT NULL,
    "closing" DECIMAL(22,10) NOT NULL,
    "average" DECIMAL(22,10) NOT NULL,
    "historical" DECIMAL(22,10) NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "consolidation_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "elimination_rules" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "left_org_id" UUID NOT NULL,
    "left_code" VARCHAR(20) NOT NULL,
    "right_org_id" UUID NOT NULL,
    "right_code" VARCHAR(20) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "elimination_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consolidation_groups_id_org_id_key" ON "consolidation_groups"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "consolidation_groups_org_id_name_key" ON "consolidation_groups"("org_id", "name");

-- CreateIndex
CREATE INDEX "consolidation_members_org_id_idx" ON "consolidation_members"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "consolidation_members_group_id_member_org_id_key" ON "consolidation_members"("group_id", "member_org_id");

-- CreateIndex
CREATE INDEX "consolidation_rates_org_id_idx" ON "consolidation_rates"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "consolidation_rates_group_id_member_org_id_period_end_key" ON "consolidation_rates"("group_id", "member_org_id", "period_end");

-- CreateIndex
CREATE INDEX "elimination_rules_org_id_idx" ON "elimination_rules"("org_id");

-- CreateIndex
CREATE INDEX "elimination_rules_group_id_idx" ON "elimination_rules"("group_id");

-- AddForeignKey
ALTER TABLE "consolidation_groups" ADD CONSTRAINT "consolidation_groups_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidation_members" ADD CONSTRAINT "consolidation_members_group_id_org_id_fkey" FOREIGN KEY ("group_id", "org_id") REFERENCES "consolidation_groups"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidation_members" ADD CONSTRAINT "consolidation_members_member_org_id_fkey" FOREIGN KEY ("member_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidation_rates" ADD CONSTRAINT "consolidation_rates_group_id_org_id_fkey" FOREIGN KEY ("group_id", "org_id") REFERENCES "consolidation_groups"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "elimination_rules" ADD CONSTRAINT "elimination_rules_group_id_org_id_fkey" FOREIGN KEY ("group_id", "org_id") REFERENCES "consolidation_groups"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A rate or rule can only name organisations that are members of the group. Removing a member
-- removes its rates; it cannot be removed while an elimination rule uses it.
ALTER TABLE "consolidation_rates" ADD CONSTRAINT "consolidation_rates_member_fk" FOREIGN KEY ("group_id", "member_org_id") REFERENCES "consolidation_members"("group_id", "member_org_id") ON DELETE CASCADE;
ALTER TABLE "elimination_rules" ADD CONSTRAINT "elimination_rules_left_member_fk" FOREIGN KEY ("group_id", "left_org_id") REFERENCES "consolidation_members"("group_id", "member_org_id") ON DELETE RESTRICT;
ALTER TABLE "elimination_rules" ADD CONSTRAINT "elimination_rules_right_member_fk" FOREIGN KEY ("group_id", "right_org_id") REFERENCES "consolidation_members"("group_id", "member_org_id") ON DELETE RESTRICT;

ALTER TABLE "consolidation_groups" ADD CONSTRAINT "consolidation_groups_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "consolidation_groups" ADD CONSTRAINT "consolidation_groups_name_check" CHECK (length(trim("name")) > 0);
ALTER TABLE "consolidation_rates" ADD CONSTRAINT "consolidation_rates_positive_check" CHECK ("closing" > 0 AND "average" > 0 AND "historical" > 0);
ALTER TABLE "elimination_rules" ADD CONSTRAINT "elimination_rules_codes_check" CHECK (length(trim("left_code")) > 0 AND length(trim("right_code")) > 0);
ALTER TABLE "elimination_rules" ADD CONSTRAINT "elimination_rules_sides_check" CHECK (("left_org_id", "left_code") IS DISTINCT FROM ("right_org_id", "right_code"));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['consolidation_groups', 'consolidation_members', 'consolidation_rates', 'elimination_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
