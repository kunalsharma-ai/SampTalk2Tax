-- Display preferences (M8): each person's interface language and number and date formats, and
-- each organisation's time zone. Display only: amounts, dates and tax rules are unchanged.
ALTER TABLE "users"
  ADD COLUMN "language" VARCHAR(8) NOT NULL DEFAULT 'en',
  ADD COLUMN "number_format" VARCHAR(8) NOT NULL DEFAULT 'AUTO',
  ADD COLUMN "date_format" VARCHAR(8) NOT NULL DEFAULT 'D_MON_Y',
  ADD COLUMN "time_zone" VARCHAR(64),
  ADD CONSTRAINT "users_language_check" CHECK ("language" IN ('en', 'hi')),
  ADD CONSTRAINT "users_number_format_check" CHECK ("number_format" IN ('AUTO', 'IN', 'INTL', 'EU', 'SPACE')),
  ADD CONSTRAINT "users_date_format_check" CHECK ("date_format" IN ('D_MON_Y', 'DMY', 'MDY', 'YMD')),
  ADD CONSTRAINT "users_time_zone_check" CHECK ("time_zone" IS NULL OR "time_zone" ~ '^[A-Za-z][A-Za-z0-9_+/-]{1,63}$');

ALTER TABLE "organizations"
  ADD COLUMN "time_zone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  ADD CONSTRAINT "organizations_time_zone_check" CHECK ("time_zone" ~ '^[A-Za-z][A-Za-z0-9_+/-]{1,63}$');
