-- Plans and subscriptions (M9 slice 2). Talk2Tax's own billing of organisations: kept apart from
-- every organisation's books (SUBS-032). Plans are platform data; subscriptions are tenant data.

CREATE TABLE "plans" (
  "id" UUID NOT NULL,
  "code" VARCHAR(24) NOT NULL,
  "name" VARCHAR(60) NOT NULL,
  "description" VARCHAR(300) NOT NULL DEFAULT '',
  -- {"INR":{"monthly":"499","annual":"4990"},"USD":{...}}
  "prices" JSONB NOT NULL,
  -- {"members":2,"aiCreditsPerMonth":null,"documentUploadsPerMonth":100}
  "limits" JSONB NOT NULL,
  "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plans_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,23}$')
);
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

CREATE TABLE "subscriptions" (
  "org_id" UUID NOT NULL,
  "plan_id" UUID NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "billing_interval" VARCHAR(8),
  "currency" CHAR(3) NOT NULL,
  "price" DECIMAL(12,2),
  "trial_ends_at" TIMESTAMPTZ(6),
  "current_period_start" TIMESTAMPTZ(6),
  "current_period_end" TIMESTAMPTZ(6),
  "payment_reference" VARCHAR(200),
  "requested_plan_id" UUID,
  "requested_interval" VARCHAR(8),
  "requested_at" TIMESTAMPTZ(6),
  "requested_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("org_id"),
  CONSTRAINT "subscriptions_status_check" CHECK ("status" IN ('TRIALING', 'ACTIVE', 'CANCELLED', 'COMPLIMENTARY')),
  CONSTRAINT "subscriptions_currency_check" CHECK ("currency" IN ('INR', 'USD')),
  CONSTRAINT "subscriptions_interval_check" CHECK ("billing_interval" IS NULL OR "billing_interval" IN ('MONTHLY', 'ANNUAL')),
  CONSTRAINT "subscriptions_trial_check" CHECK ("status" <> 'TRIALING' OR "trial_ends_at" IS NOT NULL),
  CONSTRAINT "subscriptions_paid_check" CHECK ("status" NOT IN ('ACTIVE', 'CANCELLED') OR ("billing_interval" IS NOT NULL AND "price" IS NOT NULL AND "current_period_start" IS NOT NULL AND "current_period_end" > "current_period_start")),
  CONSTRAINT "subscriptions_request_check" CHECK (("requested_plan_id" IS NULL) = ("requested_at" IS NULL) AND ("requested_plan_id" IS NULL) = ("requested_interval" IS NULL))
);
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_requested_plan_id_fkey" FOREIGN KEY ("requested_plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "subscription_events" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "actor_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "subscription_events_org_id_created_at_idx" ON "subscription_events"("org_id", "created_at");
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION subscription_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Subscription history cannot be changed or deleted';
END $$;
CREATE TRIGGER subscription_events_immutable BEFORE UPDATE OR DELETE ON "subscription_events"
  FOR EACH ROW EXECUTE FUNCTION subscription_events_immutable();

ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "subscriptions"
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
ALTER TABLE "subscription_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "subscription_events"
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());

-- The directive's proposed launch prices (not final, SUBS-010); edited in Platform administration.
INSERT INTO "plans" ("id", "code", "name", "description", "prices", "limits", "features", "sort_order", "updated_at") VALUES
  (gen_random_uuid(), 'STARTER', 'Starter', 'Bookkeeping, invoicing, banking, GST and reports for a small business.',
    '{"INR":{"monthly":"499","annual":"4990"},"USD":{"monthly":"9","annual":"90"}}', '{"members":2,"aiCreditsPerMonth":null,"documentUploadsPerMonth":100}', ARRAY[]::TEXT[], 1, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'GROWTH', 'Growth', 'Adds the AI assistant and agents, and more people.',
    '{"INR":{"monthly":"1499","annual":"14990"},"USD":{"monthly":"25","annual":"250"}}', '{"members":5,"aiCreditsPerMonth":300,"documentUploadsPerMonth":500}', ARRAY['AI'], 2, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'PROFESSIONAL', 'Professional', 'Adds payroll and foreign currencies for a growing finance team.',
    '{"INR":{"monthly":"3499","annual":"34990"},"USD":{"monthly":"59","annual":"590"}}', '{"members":15,"aiCreditsPerMonth":1500,"documentUploadsPerMonth":2000}', ARRAY['AI','PAYROLL','MULTI_CURRENCY'], 3, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'ENTERPRISE', 'Enterprise', 'Every module, including group consolidation, without member limits.',
    '{"INR":{"monthly":"8999","annual":"89990"},"USD":{"monthly":"149","annual":"1490"}}', '{"members":null,"aiCreditsPerMonth":5000,"documentUploadsPerMonth":null}', ARRAY['AI','PAYROLL','MULTI_CURRENCY','CONSOLIDATION'], 4, CURRENT_TIMESTAMP);

-- Existing organisations start a 14-day trial of every module; demo organisations are complimentary.
SELECT set_config('t2t.bypass', 'on', true);
INSERT INTO "subscriptions" ("org_id", "plan_id", "status", "currency", "trial_ends_at", "updated_at")
SELECT o.id, p.id, CASE WHEN o.is_demo THEN 'COMPLIMENTARY' ELSE 'TRIALING' END,
       CASE WHEN o.country_code = 'IN' THEN 'INR' ELSE 'USD' END,
       CASE WHEN o.is_demo THEN NULL ELSE CURRENT_TIMESTAMP + INTERVAL '14 days' END, CURRENT_TIMESTAMP
FROM "organizations" o CROSS JOIN "plans" p WHERE p.code = 'ENTERPRISE';
INSERT INTO "subscription_events" ("id", "org_id", "kind", "data")
SELECT gen_random_uuid(), s.org_id, CASE WHEN s.status = 'COMPLIMENTARY' THEN 'COMPLIMENTARY' ELSE 'TRIAL_STARTED' END,
       jsonb_build_object('plan', 'ENTERPRISE', 'note', 'Existing organisation when plans were introduced')
FROM "subscriptions" s;
