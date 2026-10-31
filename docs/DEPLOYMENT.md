# Deployment

## Local development

Prerequisites: Node 22, pnpm 10 (`corepack enable`), Docker (or a local PostgreSQL 16).

```bash
cp .env.example .env                    # then set JWT_SECRET: openssl rand -base64 48
docker compose up -d postgres           # also creates talk2tax_test
pnpm install
pnpm build
pnpm db:migrate                         # applies migrations to DATABASE_URL
pnpm db:seed                            # optional: synthetic demo company, prints a one-time password
pnpm dev:api                            # http://localhost:4000, OpenAPI at /docs
pnpm test
```

Without Docker, create the role and databases yourself:

```sql
CREATE USER talk2tax WITH PASSWORD 'talk2tax' CREATEDB;
CREATE DATABASE talk2tax OWNER talk2tax;
CREATE DATABASE talk2tax_test OWNER talk2tax;
```

The migration enables the `btree_gist` extension (trusted in PostgreSQL 13+, so the database owner can create it).

## Container

```bash
docker compose --profile app up --build   # API + Postgres
```

`apps/api/Dockerfile` builds the workspace and runs `node dist/main.js` as a non-root user. Run `prisma migrate deploy` (from `packages/database`, with `DATABASE_URL` set) as a release step before starting new API versions. This image has not yet been built in CI.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | yes | ≥ 32 chars; rotate by redeploying (invalidates tokens) |
| `JWT_TTL_SECONDS` | no | Default 3600 |
| `PORT` | no | Default 4000 |
| `CORS_ORIGINS` | no | Comma-separated allow-list |
| `TEST_DATABASE_URL` | tests | Must contain "test" |
| `DEMO_PASSWORD` | no | Fixed password for the seeded demo user |

## Production (not done yet)

Managed PostgreSQL with PITR backups, secrets from a secrets manager, TLS termination, migrations as a gated release step, health checks on `/health`, structured logs and metrics, and a staging environment. Tracked under M9.
