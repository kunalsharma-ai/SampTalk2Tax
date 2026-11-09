-- AR-018 payment links: an organisation's own Stripe or Razorpay account, and links on its invoices
-- that customers pay on the gateway's page. A paid link records an ordinary receipt.
CREATE TABLE "org_payment_gateways" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" VARCHAR(8) NOT NULL DEFAULT 'TEST',
    "currencies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "key_id" VARCHAR(100),
    "secret_cipher" TEXT,
    "secret_key_id" VARCHAR(16),
    "secret_hint" VARCHAR(16),
    "webhook_cipher" TEXT,
    "webhook_key_id" VARCHAR(16),
    "webhook_hint" VARCHAR(16),
    "deposit_account_id" UUID,
    "last_test_at" TIMESTAMPTZ(6),
    "last_test_ok" BOOLEAN,
    "last_test_message" VARCHAR(500),
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "org_payment_gateways_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "org_payment_gateways_org_id_provider_key" ON "org_payment_gateways"("org_id", "provider");
ALTER TABLE "org_payment_gateways" ADD CONSTRAINT "org_payment_gateways_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "org_payment_gateways" ADD CONSTRAINT "org_payment_gateways_deposit_fk" FOREIGN KEY ("deposit_account_id", "org_id") REFERENCES "accounts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "org_payment_gateways" ADD CONSTRAINT "org_payment_gateways_updated_by_fk" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "org_payment_gateways" ADD CONSTRAINT "org_payment_gateways_chk" CHECK (
  provider IN ('STRIPE', 'RAZORPAY') AND mode IN ('TEST', 'LIVE')
  AND (NOT enabled OR (secret_cipher IS NOT NULL AND webhook_cipher IS NOT NULL AND deposit_account_id IS NOT NULL AND cardinality(currencies) > 0))
);

CREATE TABLE "payment_links" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "document_id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "gateway_ref" VARCHAR(200) NOT NULL,
    "url" VARCHAR(1000) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    "expires_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "paid_amount" DECIMAL(24,6),
    "gateway_payment_id" VARCHAR(200),
    "payment_id" UUID,
    "settled_by" VARCHAR(100),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_links_org_id_number_key" ON "payment_links"("org_id", "number");
CREATE UNIQUE INDEX "payment_links_provider_gateway_ref_key" ON "payment_links"("provider", "gateway_ref");
CREATE UNIQUE INDEX "payment_links_payment_id_key" ON "payment_links"("payment_id");
CREATE INDEX "payment_links_org_id_document_id_idx" ON "payment_links"("org_id", "document_id");
-- At most one open link per invoice.
CREATE UNIQUE INDEX "payment_links_one_open" ON "payment_links"("document_id") WHERE status = 'OPEN';
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_document_fk" FOREIGN KEY ("document_id", "org_id") REFERENCES "documents"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_payment_fk" FOREIGN KEY ("payment_id", "org_id") REFERENCES "payments"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_chk" CHECK (
  status IN ('OPEN', 'PAID', 'CANCELLED', 'EXPIRED') AND provider IN ('STRIPE', 'RAZORPAY') AND amount > 0
  AND (status = 'PAID') = (paid_at IS NOT NULL)
  AND (status <> 'PAID' OR (paid_amount > 0 AND payment_id IS NOT NULL))
  AND (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
);

-- A link once paid, cancelled or expired stays so, and keeps its invoice, gateway and amount.
CREATE FUNCTION t2t_check_payment_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A payment link cannot be deleted; cancel it instead' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'OPEN' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'This payment link is % and cannot change', lower(OLD.status) USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.document_id, NEW.provider, NEW.gateway_ref, NEW.amount, NEW.currency, NEW.number) IS DISTINCT FROM (OLD.document_id, OLD.provider, OLD.gateway_ref, OLD.amount, OLD.currency, OLD.number) THEN
    RAISE EXCEPTION 'A payment link keeps its invoice, gateway and amount' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_links_check BEFORE UPDATE OR DELETE ON "payment_links" FOR EACH ROW EXECUTE FUNCTION t2t_check_payment_link();

-- Notices from organisations' gateways, kept so each is handled once and refusals can be seen.
CREATE TABLE "payment_link_notices" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "event_id" VARCHAR(200),
    "type" VARCHAR(100) NOT NULL,
    "signature_ok" BOOLEAN NOT NULL,
    "outcome" VARCHAR(300) NOT NULL,
    "link_id" UUID,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_link_notices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_link_notices_org_id_provider_event_id_key" ON "payment_link_notices"("org_id", "provider", "event_id");
CREATE INDEX "payment_link_notices_org_id_received_at_idx" ON "payment_link_notices"("org_id", "received_at");
ALTER TABLE "payment_link_notices" ADD CONSTRAINT "payment_link_notices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_payment_gateways', 'payment_links', 'payment_link_notices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org())', t);
  END LOOP;
END $$;
