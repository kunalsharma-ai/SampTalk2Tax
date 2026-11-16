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

The web app has no database access of its own; it talks only to the API. Its container image is described in [`CI_CD.md`](CI_CD.md).

## Containers

```bash
export JWT_SECRET=$(openssl rand -base64 48)
docker compose --profile app up --build   # Postgres → migrations → API → web app on :3000
node scripts/smoke-stack.mjs              # checks the running stack end to end
```

Three images: `talk2tax-migrate` (the release step, `prisma migrate deploy`), `talk2tax-api` and `talk2tax-web`, both distroless and non-root with health checks. Building, CI, publishing to GitHub's registry and deploying are in [`CI_CD.md`](CI_CD.md).

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | yes | ≥ 32 chars; rotate by redeploying (invalidates tokens) |
| `JWT_TTL_SECONDS` | no | Default 3600 |
| `PORT` | no | Default 4000 |
| `CORS_ORIGINS` | no | Comma-separated allow-list |
| `ANTHROPIC_API_KEY` | no | Optional fallback. Organisations add their own Claude key in Settings → Integrations ([`INTEGRATIONS.md`](INTEGRATIONS.md)); this key serves those that have not |
| `ANTHROPIC_BASE_URL` | no | Claude API endpoint, for a gateway; the browser tests point it at a local stand-in |
| `COPILOT_MODEL`, `COPILOT_MAX_TOOL_ROUNDS`, `COPILOT_TURN_TIMEOUT_SECONDS` | no | Default `claude-opus-5-5`, 8 rounds of tool calls, 240 seconds per answer |
| `ALERTS_RUNNER_INTERVAL_SECONDS` | no | How often the background alert checks look for organisations not checked in the last hour (20 a pass). Default 300; 0 turns them off (alerts are still checked when opened). |
| `WORKFLOW_RUNNER_INTERVAL_SECONDS` | no | How often the automation runner looks for events and due webhooks. Default 10; 0 turns the runner off |
| `WEBHOOK_ALLOW_PRIVATE_NETWORKS` | no | `true` lets webhooks use http:// and reach private and loopback addresses. Development and tests only; must be false (the default) in production |
| `WEBHOOK_TIMEOUT_SECONDS` | no | Longest a webhook delivery may take. Default 10 |
| `SMTP_URL` | no | Optional fallback. Organisations add their own mail server in Settings → Integrations; this one serves those that have not: `smtp://user:password@host:587` (STARTTLS when offered; add `?requireTLS=true` to insist) or `smtps://user:password@host:465`. Unset: email actions fail with "Email is not set up" |
| `EMAIL_FROM` | with `SMTP_URL` | The sender of every email, such as `Talk2Tax <no-reply@example.com>`. Required when `SMTP_URL` is set. Set up SPF and DKIM for its domain with your mail provider |
| `SMTP_TIMEOUT_SECONDS` | no | Longest one SMTP delivery may take. Default 20 |
| `INTEGRATIONS_ENCRYPTION_KEY` | no | Encrypts the API keys and SMTP passwords organisations enter in Settings → Integrations (AES-256-GCM). Unset: a key derived from `JWT_SECRET`. Changing either means those secrets must be entered again (the page says so) |
| `APP_URL` | no | The web app's public address, for links in emails to members. Default `http://localhost:3000` |
| `DEPLOYMENT_REGION`, `DEPLOYMENT_REGION_NAME` | no | The region this deployment serves (default `local`, `Local server`). Organisations are tagged with it; see [`REGIONAL_DEPLOYMENT.md`](REGIONAL_DEPLOYMENT.md) |
| `PLAN_TRIAL_DAYS` | no | Days a new organisation's trial of every module lasts. Default 14 |
| `BILLING_RUNNER_INTERVAL_SECONDS` | no | How often renewal invoices and reminders are checked. Default 3600; 0 turns it off |
| `CONTRACT_RUNNER_INTERVAL_SECONDS` | no | How often customer contracts are billed as periods fall due. Default 3600; 0 turns it off |
| `RECURRING_JOURNAL_RUNNER_INTERVAL_SECONDS` | no | How often recurring journals are made as their runs fall due. Default 3600; 0 turns it off |
| `PAYMENTS_TIMEOUT_SECONDS` | no | Seconds to wait for a payment gateway. Default 20 |
| `PAYMENTS_STRIPE_API_URL`, `PAYMENTS_RAZORPAY_API_URL` | no | Tests and previews only: point the gateway clients at the local stand-in. Gateways themselves are set up in Platform admin → Payments |
| `REGION_DIRECTORY` | no | JSON of the other regions and their web addresses, used to point people to an organisation's home region |
| `TEST_DATABASE_URL` | tests | Must contain "test" |
| `DEMO_PASSWORD` | no | Fixed password for the seeded demo user |
| `GIT_SHA` | no | The commit being run, baked into the images; shown under Platform admin → System health |
| `T2T_API_URL` | web | API base URL used by the web app's server-side proxy. Default `http://localhost:4000` |
| `WEB_URL` | e2e | Web app address for browser tests. Default `http://localhost:3000` |

## First platform administrator

Register in the app, then on the API host run `pnpm --filter @talk2tax/api admin:grant --email you@example.com`. See [`PLATFORM_ADMINISTRATION.md`](PLATFORM_ADMINISTRATION.md).

## Production

`deploy/docker-compose.prod.yml` runs the published images on one Docker host behind Caddy (automatic TLS), with managed PostgreSQL and settings in `.env.production`; `.github/workflows/release.yml` deploys a version to it after an approval, running migrations first. See [`CI_CD.md`](CI_CD.md). Not done yet: a staging environment, secrets from a secrets manager rather than the host's env file, structured log shipping, and more than one host.
