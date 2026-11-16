-- GL-011: year-end close of revenue and expense accounts to retained earnings.
ALTER TYPE "JournalSource" ADD VALUE 'YEAR_END';
CREATE TYPE "YearEndCloseStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- Each time a fiscal year is closed (or closed again after a late change): what was left in its
-- revenue and expense accounts, moved to retained earnings by one closing journal.
CREATE TABLE "year_end_closes" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "closing_date" DATE NOT NULL,
    "retained_earnings_account_id" UUID NOT NULL,
    "profit" DECIMAL(24,6) NOT NULL,
    "to_retained_earnings" DECIMAL(24,6) NOT NULL,
    "accounts" INTEGER NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "memo" VARCHAR(400),
    "status" "YearEndCloseStatus" NOT NULL DEFAULT 'ACTIVE',
    "reversed_on" DATE,
    "reversal_reason" VARCHAR(500),
    "reversal_journal_entry_id" UUID,
    "reversed_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "year_end_closes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "year_end_closes_org_id_number_key" ON "year_end_closes"("org_id", "number");
CREATE UNIQUE INDEX "year_end_closes_id_org_id_key" ON "year_end_closes"("id", "org_id");
CREATE UNIQUE INDEX "year_end_closes_journal_entry_id_key" ON "year_end_closes"("journal_entry_id");
CREATE UNIQUE INDEX "year_end_closes_reversal_journal_entry_id_key" ON "year_end_closes"("reversal_journal_entry_id");
CREATE INDEX "year_end_closes_org_id_fiscal_year_idx" ON "year_end_closes"("org_id", "fiscal_year");

ALTER TABLE "year_end_closes" ADD CONSTRAINT "year_end_closes_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_closes" ADD CONSTRAINT "year_end_closes_account_fk" FOREIGN KEY ("retained_earnings_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_closes" ADD CONSTRAINT "year_end_closes_journal_fk" FOREIGN KEY ("journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_closes" ADD CONSTRAINT "year_end_closes_reversal_fk" FOREIGN KEY ("reversal_journal_entry_id", "org_id") REFERENCES "journal_entries"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_closes" ADD CONSTRAINT "year_end_closes_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_closes" ADD CONSTRAINT "year_end_closes_reversed_by_fk" FOREIGN KEY ("reversed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_closes" ADD CONSTRAINT "year_end_closes_chk" CHECK (
  number > 0 AND accounts > 0
  AND ((status = 'REVERSED') = (reversed_on IS NOT NULL AND reversal_journal_entry_id IS NOT NULL AND reversal_reason IS NOT NULL AND reversed_by_id IS NOT NULL))
  AND (reversed_on IS NULL OR reversed_on >= closing_date)
);

-- A close keeps its figures; the only change is being reversed once.
CREATE FUNCTION t2t_guard_year_end_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A year-end close cannot be deleted; reopen the year instead' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'REVERSED' OR NEW.status <> 'REVERSED'
     OR (NEW.org_id, NEW.number, NEW.fiscal_year, NEW.closing_date, NEW.retained_earnings_account_id, NEW.profit, NEW.to_retained_earnings, NEW.accounts, NEW.journal_entry_id, NEW.memo, NEW.created_by_id)
        IS DISTINCT FROM (OLD.org_id, OLD.number, OLD.fiscal_year, OLD.closing_date, OLD.retained_earnings_account_id, OLD.profit, OLD.to_retained_earnings, OLD.accounts, OLD.journal_entry_id, OLD.memo, OLD.created_by_id) THEN
    RAISE EXCEPTION 'A year-end close is immutable apart from being reversed once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER year_end_closes_guard BEFORE UPDATE OR DELETE ON "year_end_closes" FOR EACH ROW EXECUTE FUNCTION t2t_guard_year_end_close();

-- A closing journal is never a draft and never edited by hand: the guard on posted entries already
-- covers edits; a closing entry's type cannot change either way after posting.
CREATE FUNCTION t2t_guard_closing_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'POSTED' AND NEW.type IS DISTINCT FROM OLD.type THEN
    RAISE EXCEPTION 'The type of a posted journal cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_closing_type_guard BEFORE UPDATE ON "journal_entries" FOR EACH ROW EXECUTE FUNCTION t2t_guard_closing_type();

ALTER TABLE "year_end_closes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "year_end_closes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "year_end_closes" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
