-- Foreign-currency revaluation: an exchange-rate table per organisation and the record of each
-- period-end revaluation (posted on its date, reversed the next day).

ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'FX_REVALUATION';

CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "date" DATE NOT NULL,
    "rate" DECIMAL(24,10) NOT NULL,
    "source" VARCHAR(200),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "exchange_rates_org_id_currency_date_key" ON "exchange_rates"("org_id", "currency", "date");
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_rate_check" CHECK ("rate" > 0);
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "exchange_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exchange_rates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "exchange_rates" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());

CREATE TABLE "fx_revaluations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "reversal_date" DATE NOT NULL,
    "rates" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "gain" DECIMAL(24,6) NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "reversal_entry_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fx_revaluations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "fx_revaluations_org_id_number_key" ON "fx_revaluations"("org_id", "number");
CREATE UNIQUE INDEX "fx_revaluations_org_id_date_key" ON "fx_revaluations"("org_id", "date");
CREATE UNIQUE INDEX "fx_revaluations_journal_entry_id_key" ON "fx_revaluations"("journal_entry_id");
CREATE UNIQUE INDEX "fx_revaluations_reversal_entry_id_key" ON "fx_revaluations"("reversal_entry_id");
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_reversal_entry_id_fkey" FOREIGN KEY ("reversal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_dates_check" CHECK ("reversal_date" > "date");
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_lines_check" CHECK (jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") > 0);
ALTER TABLE "fx_revaluations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fx_revaluations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "fx_revaluations" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());

-- A revaluation is a record of what was posted: it never changes and is never deleted.
CREATE OR REPLACE FUNCTION fx_revaluations_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fx_revaluations rows cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER fx_revaluations_no_change BEFORE UPDATE OR DELETE ON "fx_revaluations" FOR EACH ROW EXECUTE FUNCTION fx_revaluations_immutable();
