-- Regional deployments: each organisation's data lives in one region (data residency).
-- A deployment (API + database) serves one region. Organisations are tagged with the region
-- they were created in; an API in another region refuses them and points to their home.
ALTER TABLE "organizations" ADD COLUMN "data_region" VARCHAR(32);
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_data_region_format"
  CHECK ("data_region" IS NULL OR "data_region" ~ '^[a-z0-9-]{2,32}$');

-- Rows from before this migration are claimed by the region of the first API that starts on
-- this database. Once set, the region can be changed (a move) but never cleared.
CREATE FUNCTION organizations_data_region_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.data_region IS NOT NULL AND NEW.data_region IS NULL THEN
    RAISE EXCEPTION 'An organisation''s data region cannot be cleared';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_data_region_kept BEFORE UPDATE OF data_region ON "organizations"
  FOR EACH ROW EXECUTE FUNCTION organizations_data_region_kept();
