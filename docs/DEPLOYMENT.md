# Deployment

## Local development

Prerequisites: Node 22, pnpm 10 (`corepack enable`), Docker (or a local PostgreSQL 16).

```bash
cp .env.example .env                    # then set JWT_SECRET: openssl rand -base64 48
docker compose up -d postgres           # creates the talk2tax role and both databases
pnpm install
pnpm build
pnpm db:migrate                         # applies migrations to DATABASE_URL
pnpm db:seed                            # optional: synthetic demo company, prints a one-time password
pnpm dev:api                            # http://localhost:4000, OpenAPI at /docs
pnpm dev:web                            # http://localhost:3000 (Next.js dev server)
pnpm test
```

Without Docker, create the role and databases yourself:

```sql
CREATE USER talk2tax WITH PASSWORD 'talk2tax' CREATEDB NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE talk2tax OWNER talk2tax;
CREATE DATABASE talk2tax_test OWNER talk2tax;
```

The app role must not be a superuser or have `BYPASSRLS`, or row-level security does not apply (the API refuses to start that way in production). If you used an earlier `docker compose` volume, where `talk2tax` was the container superuser, recreate it with `docker compose down -v`.

The migration enables the `btree_gist` extension (trusted in PostgreSQL 13+, so the database owner can create it).

## Web app in production mode

```bash
pnpm build                              # includes next build for apps/web
cd apps/web && T2T_API_URL=http://localhost:4000 npx next start -p 3000
pnpm e2e                                # from the repo root, with both servers running
```

The web app has no database access of its own; it talks only to the API. There is no web container image yet.

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
| `ANTHROPIC_API_KEY` | no | AI copilot. Without it the copilot says it is not set up and sends nothing. Each organisation must also turn the copilot on |
| `ANTHROPIC_BASE_URL` | no | Claude API endpoint, for a gateway; the browser tests point it at a local stand-in |
| `COPILOT_MODEL`, `COPILOT_MAX_TOOL_ROUNDS`, `COPILOT_TURN_TIMEOUT_SECONDS` | no | Default `claude-opus-5-5`, 8 rounds of tool calls, 240 seconds per answer |
| `TEST_DATABASE_URL` | tests | Must contain "test" |
| `DEMO_PASSWORD` | no | Fixed password for the seeded demo user |
| `T2T_API_URL` | web | API base URL used by the web app's server-side proxy. Default `http://localhost:4000` |
| `WEB_URL` | e2e | Web app address for browser tests. Default `http://localhost:3000` |

## Production (not done yet)

Managed PostgreSQL with PITR backups, secrets from a secrets manager, TLS termination, migrations as a gated release step, health checks on `/health`, structured logs and metrics, and a staging environment. Tracked under M9.
