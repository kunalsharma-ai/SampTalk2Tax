-- AP-021 vendor performance: the team's own reviews of a vendor, next to the scorecard worked out
-- from purchase orders, goods receipts and bills. A review is never edited or deleted; the person
-- who wrote it may withdraw it, which keeps it on record but leaves it out of the score.
CREATE TABLE "vendor_reviews" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "order_id" UUID,
    "review_date" DATE NOT NULL,
    "aspect" VARCHAR(20) NOT NULL,
    "rating" SMALLINT NOT NULL,
    "note" VARCHAR(2000),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_by_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdraw_reason" VARCHAR(500),
    CONSTRAINT "vendor_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vendor_reviews_chk" CHECK (
      rating BETWEEN 1 AND 5
      AND aspect IN ('Quality', 'Delivery', 'Communication', 'Pricing', 'Overall')
      AND (rating > 2 OR length(btrim(coalesce(note, ''))) > 0)
      AND ((withdrawn_at IS NULL) = (withdrawn_by_id IS NULL))
      AND (withdrawn_at IS NULL OR (withdrawn_by_id = created_by_id AND length(btrim(coalesce(withdraw_reason, ''))) > 0))
    )
);
CREATE UNIQUE INDEX "vendor_reviews_id_org_id_key" ON "vendor_reviews"("id", "org_id");
CREATE INDEX "vendor_reviews_org_id_contact_id_idx" ON "vendor_reviews"("org_id", "contact_id", "review_date");
ALTER TABLE "vendor_reviews" ADD CONSTRAINT "vendor_reviews_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_reviews" ADD CONSTRAINT "vendor_reviews_contact_fk" FOREIGN KEY ("contact_id", "org_id") REFERENCES "contacts"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_reviews" ADD CONSTRAINT "vendor_reviews_order_fk" FOREIGN KEY ("order_id", "org_id") REFERENCES "purchase_orders"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_reviews" ADD CONSTRAINT "vendor_reviews_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_reviews" ADD CONSTRAINT "vendor_reviews_withdrawn_by_fk" FOREIGN KEY ("withdrawn_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION t2t_check_vendor_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A vendor review cannot be deleted; withdraw it instead' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'This vendor review has been withdrawn' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.contact_id, NEW.order_id, NEW.review_date, NEW.aspect, NEW.rating, NEW.note, NEW.created_by_id, NEW.created_at)
       IS DISTINCT FROM (OLD.contact_id, OLD.order_id, OLD.review_date, OLD.aspect, OLD.rating, OLD.note, OLD.created_by_id, OLD.created_at) THEN
      RAISE EXCEPTION 'A vendor review is never edited; withdraw it and write a new one' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT is_vendor INTO c FROM contacts WHERE id = NEW.contact_id AND org_id = NEW.org_id;
  IF NOT c.is_vendor THEN
    RAISE EXCEPTION 'Only a vendor can be reviewed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM purchase_orders o WHERE o.id = NEW.order_id AND o.org_id = NEW.org_id AND o.contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'A review can only refer to a purchase order from the same vendor' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vendor_reviews_check BEFORE INSERT OR UPDATE OR DELETE ON "vendor_reviews" FOR EACH ROW EXECUTE FUNCTION t2t_check_vendor_review();

ALTER TABLE "vendor_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendor_reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vendor_reviews" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
