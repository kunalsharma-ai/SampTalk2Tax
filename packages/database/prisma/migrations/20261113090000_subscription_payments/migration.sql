-- Online payment of subscriptions (M9 slice 3): the platform's payment gateways and seller
-- details (set up in Platform administration), subscription invoices with their tax, received
-- webhooks, and the running numbers of tax invoices. Platform billing only, never an
-- organisation's books.

CREATE TABLE "platform_payment_gateways" (
  "provider" VARCHAR(16) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "mode" VARCHAR(8) NOT NULL DEFAULT 'TEST',
  "currencies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Razorpay's key id (not secret; sent with the secret on each call). Stripe has none.
  "key_id" VARCHAR(100),
  "secret_cipher" TEXT,
  "secret_key_id" VARCHAR(16),
  "secret_hint" VARCHAR(16),
  "webhook_cipher" TEXT,
  "webhook_key_id" VARCHAR(16),
  "webhook_hint" VARCHAR(16),
  "last_test_at" TIMESTAMPTZ(6),
  "last_test_ok" BOOLEAN,
  "last_test_message" VARCHAR(500),
  "updated_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "platform_payment_gateways_pkey" PRIMARY KEY ("provider"),
  CONSTRAINT "platform_payment_gateways_provider_check" CHECK ("provider" IN ('STRIPE', 'RAZORPAY')),
  CONSTRAINT "platform_payment_gateways_mode_check" CHECK ("mode" IN ('TEST', 'LIVE')),
  CONSTRAINT "platform_payment_gateways_currencies_check" CHECK ("currencies" <@ ARRAY['INR', 'USD']::TEXT[]),
  CONSTRAINT "platform_payment_gateways_enabled_check" CHECK (NOT "enabled" OR ("secret_cipher" IS NOT NULL AND "webhook_cipher" IS NOT NULL AND cardinality("currencies") > 0))
);

CREATE TABLE "platform_billing_profile" (
  "id" SMALLINT NOT NULL DEFAULT 1,
  "legal_name" VARCHAR(200) NOT NULL,
  "address" VARCHAR(500) NOT NULL DEFAULT '',
  "country_code" CHAR(2) NOT NULL,
  "gstin" VARCHAR(15),
  "state_code" CHAR(2),
  "email" VARCHAR(200),
  "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 18,
  "sac_code" VARCHAR(8) NOT NULL DEFAULT '998314',
  "invoice_prefix" VARCHAR(4) NOT NULL DEFAULT 'T2T',
  "updated_by" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "platform_billing_profile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_billing_profile_one_check" CHECK ("id" = 1),
  CONSTRAINT "platform_billing_profile_prefix_check" CHECK ("invoice_prefix" ~ '^[A-Z0-9]{1,4}$'),
  CONSTRAINT "platform_billing_profile_gst_check" CHECK (("gstin" IS NULL) = ("state_code" IS NULL) AND "gst_rate" >= 0 AND "gst_rate" <= 28)
);

CREATE TABLE "subscription_invoices" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  -- Shown while unpaid (a payment request); the tax invoice number is given on payment.
  "reference" VARCHAR(16) NOT NULL,
  "number" VARCHAR(16),
  "kind" VARCHAR(8) NOT NULL,
  "status" VARCHAR(8) NOT NULL DEFAULT 'OPEN',
  "plan_id" UUID NOT NULL,
  "billing_interval" VARCHAR(8) NOT NULL,
  "list_price" DECIMAL(12,2) NOT NULL,
  "period_start" TIMESTAMPTZ(6) NOT NULL,
  "period_end" TIMESTAMPTZ(6) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "subtotal" DECIMAL(12,2) NOT NULL,
  "tax_lines" JSONB NOT NULL DEFAULT '[]',
  "tax_total" DECIMAL(12,2) NOT NULL,
  "total" DECIMAL(12,2) NOT NULL,
  "tax_note" VARCHAR(300) NOT NULL DEFAULT '',
  "place_of_supply" VARCHAR(40),
  "seller" JSONB NOT NULL,
  "buyer" JSONB NOT NULL,
  "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "due_at" TIMESTAMPTZ(6) NOT NULL,
  "paid_at" TIMESTAMPTZ(6),
  "voided_at" TIMESTAMPTZ(6),
  "void_reason" VARCHAR(300),
  "gateway" VARCHAR(16),
  "checkout_ref" VARCHAR(100),
  "checkout_url" VARCHAR(1000),
  "checkout_expires_at" TIMESTAMPTZ(6),
  "payment_ref" VARCHAR(200),
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_invoices_kind_check" CHECK ("kind" IN ('NEW', 'RENEWAL', 'UPGRADE')),
  CONSTRAINT "subscription_invoices_status_check" CHECK ("status" IN ('OPEN', 'PAID', 'VOID')),
  CONSTRAINT "subscription_invoices_interval_check" CHECK ("billing_interval" IN ('MONTHLY', 'ANNUAL')),
  CONSTRAINT "subscription_invoices_currency_check" CHECK ("currency" IN ('INR', 'USD')),
  CONSTRAINT "subscription_invoices_period_check" CHECK ("period_end" > "period_start"),
  CONSTRAINT "subscription_invoices_amounts_check" CHECK ("subtotal" > 0 AND "tax_total" >= 0 AND "total" = "subtotal" + "tax_total"),
  CONSTRAINT "subscription_invoices_paid_check" CHECK (("status" = 'PAID') = ("paid_at" IS NOT NULL) AND ("status" = 'PAID') = ("number" IS NOT NULL) AND ("status" <> 'PAID' OR "payment_ref" IS NOT NULL)),
  CONSTRAINT "subscription_invoices_void_check" CHECK (("status" = 'VOID') = ("voided_at" IS NOT NULL) AND ("status" <> 'VOID' OR "void_reason" IS NOT NULL)),
  CONSTRAINT "subscription_invoices_gateway_check" CHECK ("gateway" IS NULL OR "gateway" IN ('STRIPE', 'RAZORPAY', 'MANUAL'))
);
CREATE UNIQUE INDEX "subscription_invoices_reference_key" ON "subscription_invoices"("reference");
CREATE UNIQUE INDEX "subscription_invoices_number_key" ON "subscription_invoices"("number");
CREATE UNIQUE INDEX "subscription_invoices_checkout_key" ON "subscription_invoices"("gateway", "checkout_ref");
-- One unpaid invoice per organisation: a new checkout replaces (voids) the one before.
CREATE UNIQUE INDEX "subscription_invoices_one_open" ON "subscription_invoices"("org_id") WHERE "status" = 'OPEN';
CREATE INDEX "subscription_invoices_org_id_issued_at_idx" ON "subscription_invoices"("org_id", "issued_at");
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A paid or voided invoice is final; nothing is ever deleted.
CREATE FUNCTION subscription_invoices_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Subscription invoices cannot be deleted';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'A % subscription invoice cannot be changed', lower(OLD."status");
  END IF;
  IF NEW."subtotal" <> OLD."subtotal" OR NEW."total" <> OLD."total" OR NEW."currency" <> OLD."currency" OR NEW."org_id" <> OLD."org_id" OR NEW."reference" <> OLD."reference" THEN
    RAISE EXCEPTION 'The amount of a subscription invoice cannot be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_invoices_final BEFORE UPDATE OR DELETE ON "subscription_invoices"
  FOR EACH ROW EXECUTE FUNCTION subscription_invoices_final();

ALTER TABLE "subscription_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription_invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "subscription_invoices"
  USING (t2t_rls_bypass() OR org_id = t2t_current_org())
  WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());

-- Tax invoice running numbers, one series per Indian financial year ("26-27").
CREATE TABLE "subscription_invoice_counters" (
  "series" VARCHAR(8) NOT NULL,
  "last" INTEGER NOT NULL,
  CONSTRAINT "subscription_invoice_counters_pkey" PRIMARY KEY ("series"),
  CONSTRAINT "subscription_invoice_counters_last_check" CHECK ("last" >= 1)
);

-- Every notification a gateway sent, whether or not its signature was valid (kept for support).
CREATE TABLE "payment_webhook_events" (
  "id" UUID NOT NULL,
  "provider" VARCHAR(16) NOT NULL,
  "event_id" VARCHAR(200),
  "type" VARCHAR(100) NOT NULL DEFAULT '',
  "signature_ok" BOOLEAN NOT NULL,
  "outcome" VARCHAR(300) NOT NULL,
  "invoice_id" UUID,
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_webhook_events_provider_event_id_key" ON "payment_webhook_events"("provider", "event_id");
CREATE INDEX "payment_webhook_events_received_at_idx" ON "payment_webhook_events"("received_at");
