-- CreateEnum
CREATE TYPE "IntercompanyKind" AS ENUM ('CHARGE', 'SETTLEMENT');

-- AlterEnum
ALTER TYPE "JournalSource" ADD VALUE 'INTERCOMPANY';























































































-- AlterTable
ALTER TABLE "consolidation_members" ADD COLUMN     "ic_expense_code" VARCHAR(20),
ADD COLUMN     "ic_payable_code" VARCHAR(20),
ADD COLUMN     "ic_receivable_code" VARCHAR(20),
ADD COLUMN     "ic_revenue_code" VARCHAR(20);

-- CreateTable
CREATE TABLE "intercompany_transactions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "IntercompanyKind" NOT NULL,
    "from_org_id" UUID NOT NULL,
    "to_org_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "from_currency" CHAR(3) NOT NULL,
    "to_amount" DECIMAL(20,4) NOT NULL,
    "to_currency" CHAR(3) NOT NULL,
    "from_receivable_code" VARCHAR(20) NOT NULL,
    "to_payable_code" VARCHAR(20) NOT NULL,
    "from_revenue_code" VARCHAR(20),
    "to_expense_code" VARCHAR(20),
    "from_bank_code" VARCHAR(20),
    "to_bank_code" VARCHAR(20),
    "from_entry_id" UUID NOT NULL,
    "to_entry_id" UUID NOT NULL,
    "reversed_on" DATE,
    "from_reversal_id" UUID,
    "to_reversal_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_by_id" UUID,

    CONSTRAINT "intercompany_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intercompany_transactions_org_id_idx" ON "intercompany_transactions"("org_id");

-- CreateIndex
CREATE INDEX "intercompany_transactions_group_id_date_idx" ON "intercompany_transactions"("group_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "intercompany_transactions_group_id_number_key" ON "intercompany_transactions"("group_id", "number");

-- AddForeignKey
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_group_id_org_id_fkey" FOREIGN KEY ("group_id", "org_id") REFERENCES "consolidation_groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Both companies must be members of the group; a member with intercompany transactions stays.
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_from_member_fk" FOREIGN KEY ("group_id", "from_org_id") REFERENCES "consolidation_members"("group_id", "member_org_id") ON DELETE RESTRICT;
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_to_member_fk" FOREIGN KEY ("group_id", "to_org_id") REFERENCES "consolidation_members"("group_id", "member_org_id") ON DELETE RESTRICT;
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_from_entry_fk" FOREIGN KEY ("from_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_to_entry_fk" FOREIGN KEY ("to_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_from_reversal_fk" FOREIGN KEY ("from_reversal_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_to_reversal_fk" FOREIGN KEY ("to_reversal_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_checks" CHECK (
  "from_org_id" <> "to_org_id"
  AND "amount" > 0 AND "to_amount" > 0
  AND "number" > 0
  AND length(btrim("description")) > 0
  AND (("kind" = 'CHARGE' AND "from_revenue_code" IS NOT NULL AND "to_expense_code" IS NOT NULL AND "from_bank_code" IS NULL AND "to_bank_code" IS NULL)
    OR ("kind" = 'SETTLEMENT' AND "from_bank_code" IS NOT NULL AND "to_bank_code" IS NOT NULL AND "from_revenue_code" IS NULL AND "to_expense_code" IS NULL))
  AND (("reversed_on" IS NULL AND "from_reversal_id" IS NULL AND "to_reversal_id" IS NULL AND "reversed_by_id" IS NULL)
    OR ("reversed_on" IS NOT NULL AND "from_reversal_id" IS NOT NULL AND "to_reversal_id" IS NOT NULL AND "reversed_by_id" IS NOT NULL AND "reversed_on" >= "date"))
);

ALTER TABLE "intercompany_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intercompany_transactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "intercompany_transactions" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
