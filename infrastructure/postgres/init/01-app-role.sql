-- The API connects as an ordinary role. The container's POSTGRES_USER is a superuser,
-- and a superuser skips row-level security, so the app must not use it.
CREATE ROLE talk2tax LOGIN PASSWORD 'talk2tax' NOSUPERUSER NOBYPASSRLS NOCREATEROLE CREATEDB;
CREATE DATABASE talk2tax OWNER talk2tax;
-- Separate database used by the API integration tests.
CREATE DATABASE talk2tax_test OWNER talk2tax;
