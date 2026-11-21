# Deployment

## Local development

Prerequisites: Node 26, pnpm 10 (Node 26 no longer bundles corepack: `npm install -g corepack && corepack enable`), Docker (or a local MongoDB 8 started as a replica set).

```bash
cp .env.example .env                    # then set JWT_SECRET: openssl rand -base64 48
docker compose up -d mongo              # MongoDB as a one-node replica set (rs0)
pnpm install
pnpm build
pnpm db:migrate                         # applies MongoDB migrations to MONGODB_URL
pnpm db:seed                            # optional: synthetic demo company, prints a one-time password
pnpm dev:api                            # http://localhost:4000, OpenAPI at /docs
pnpm dev:web                            # http://localhost:3000 (Next.js dev server)
pnpm test
```

Without Docker, start `mongod --replSet rs0` and run `rs.initiate()` once in `mongosh`. Transactions need a replica set; the API refuses to start against a standalone server. The databases are created on first use. An installation that ran on PostgreSQL is upgraded as described in [`MONGODB.md`](MONGODB.md#upgrading-an-installation-that-ran-on-postgresql).

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
docker compose --profile app up --build   # MongoDB → migrations → API → web app on :3000
node scripts/smoke-stack.mjs              # checks the running stack end to end
```

Three images: `talk2tax-migrate` (the release step, the MongoDB migrations), `talk2tax-api` and `talk2tax-web`, both distroless and non-root with health checks. Building, CI, publishing to GitHub's registry and deploying are in [`CI_CD.md`](CI_CD.md).

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URL` | yes | MongoDB connection string; must reach a replica set (`?replicaSet=rs0`) |
| `JWT_SECRET` | yes | ≥ 32 chars; rotate by redeploying (invalidates tokens) |
| `<NAME>_FILE` | no | Read a secret from a file instead of the environment (Docker/Kubernetes secrets), for `JWT_SECRET`, `MONGODB_URL`, `INTEGRATIONS_ENCRYPTION_KEY`, `INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS`, `ANTHROPIC_API_KEY`, `SMTP_URL`, `SMTP_PASS` and `BACKUP_ENCRYPTION_KEY`. Not with `<NAME>` as well. In production, example or low-entropy secrets are refused at startup |
| `SECURITY_CONTACT` | no | Web app. `mailto:` or `https:` addresses (comma-separated) for reporting vulnerabilities; served as `/.well-known/security.txt` with `SECURITY_POLICY_URL` and `SECURITY_TXT_EXPIRES_DAYS` (default 180, at most 365). Unset: 404 |
| `JWT_TTL_SECONDS` | no | Default 3600 |
| `PORT` | no | Default 4000 |
| `CORS_ORIGINS` | no | Comma-separated allow-list |
| `ANTHROPIC_API_KEY` | no | Optional fallback. Organisations add their own Claude key in Settings → Integrations ([`INTEGRATIONS.md`](INTEGRATIONS.md)); this key serves those that have not |
| `ANTHROPIC_BASE_URL` | no | Claude API endpoint, for a gateway; the browser tests point it at a local stand-in |
| `COPILOT_MODEL`, `COPILOT_MAX_TOOL_ROUNDS`, `COPILOT_TURN_TIMEOUT_SECONDS` | no | Default `claude-opus-5-5`, 8 rounds of tool calls, 240 seconds per answer |
| `AI_AGENT_TASKS_PER_HOUR` | no | AI tasks each agent may start per hour in one organisation, unless the organisation sets its own (default 500; 0 = no default limit) |
| `SECURITY_MONITOR_INTERVAL_SECONDS`, `SECURITY_LOCKOUT_ALERT_COUNT` | no | How often the audit trail is checked for security alerts (default 300 s; 0 = off) and how many lockouts in an hour raise one (default 5). Alerts are emailed to super admins through `SMTP_*` |
| `ALERTS_RUNNER_INTERVAL_SECONDS` | no | How often the background alert checks look for organisations not checked in the last hour (20 a pass). Default 300; 0 turns them off (alerts are still checked when opened). |
| `WORKFLOW_RUNNER_INTERVAL_SECONDS` | no | How often the automation runner looks for events and due webhooks. Default 10; 0 turns the runner off |
| `WEBHOOK_ALLOW_PRIVATE_NETWORKS` | no | `true` lets webhooks use http:// and reach private and loopback addresses. Development and tests only; must be false (the default) in production |
| `WEBHOOK_TIMEOUT_SECONDS` | no | Longest a webhook delivery may take. Default 10 |
| `SMTP_URL` | no | Optional fallback. Organisations add their own mail server in Settings → Integrations; this one serves those that have not: `smtp://user:password@host:587` (STARTTLS when offered; add `?requireTLS=true` to insist) or `smtps://user:password@host:465`. Unset: email actions fail with "Email is not set up" |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | no | The same fallback as separate settings, used when `SMTP_URL` is unset. Zoho Mail India: `smtppro.zoho.in`, `465`, `true`, the sender address and its app password. `SMTP_PORT` defaults to 465 and `SMTP_SECURE` to `true`; `SMTP_PASS` is required with `SMTP_USER` |
| `EMAIL_FROM` | with `SMTP_URL` | The sender of every email, such as `Talk2Tax <no-reply@example.com>`. Required when `SMTP_URL` is set. Set up SPF and DKIM for its domain with your mail provider |
| `SMTP_TIMEOUT_SECONDS` | no | Longest one SMTP delivery may take. Default 20 |
| `INTEGRATIONS_ENCRYPTION_KEY` | no | Encrypts the API keys and SMTP passwords organisations enter in Settings → Integrations (AES-256-GCM). Unset: a key derived from `JWT_SECRET`. To rotate, list the old key in `INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS` and re-encrypt under Platform admin → Encryption keys (see `SECURITY.md`); otherwise a change means those secrets must be entered again |
| `INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS` | no | Keys used before, comma-separated; an old key derived from `JWT_SECRET` is written `jwt:<old JWT_SECRET>`. Secrets sealed with them still open until re-encrypted |
| `APP_URL` | no | The web app's public address, for links in emails to members. Default `http://localhost:3000` |
| `HTTPS_ONLY` | no | Encryption in transit (SEC-010). API: `true` refuses requests that did not reach Talk2Tax over HTTPS (`X-Forwarded-Proto` from a trusted proxy, so `TRUST_PROXY_HOPS` ≥ 1), except `/health`; unset: on in production when `APP_URL` is `https://`. Web app: on by default in a production build (sends `http://` visitors to `https://` with a 308 and adds `Strict-Transport-Security` to HTTPS responses; `localhost` is left alone); `false` turns it off |
| `MONGODB_REQUIRE_TLS` | no | The API refuses to start unless `MONGODB_URL` is `mongodb+srv://` or has `tls=true`. Default: the same as `HTTPS_ONLY`. Set `false` only for a database on a private network you trust |
| `BACKUP_ENCRYPTION_KEY` | for backups | Passphrase (16+ characters) the backup command encrypts and reads backups with. Keep it in your secrets manager, apart from the backups. See [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) |
| `BACKUP_MAX_AGE_HOURS` | no | Hours after which the newest good backup counts as overdue (Platform admin → Backups, System health). Default 26; 0 turns the check off |
| `RESTORE_DRILL_MAX_AGE_DAYS` | no | Days after which the last restore drill counts as overdue. Default 35; 0 turns the check off |
| `DEPLOYMENT_REGION`, `DEPLOYMENT_REGION_NAME` | no | The region this deployment serves (default `local`, `Local server`). Organisations are tagged with it; see [`REGIONAL_DEPLOYMENT.md`](REGIONAL_DEPLOYMENT.md) |
| `PLAN_TRIAL_DAYS` | no | Days a new organisation's trial of every module lasts. Default 14 |
| `BILLING_RUNNER_INTERVAL_SECONDS` | no | How often renewal invoices and reminders are checked. Default 3600; 0 turns it off |
| `CONTRACT_RUNNER_INTERVAL_SECONDS` | no | How often customer contracts are billed as periods fall due. Default 3600; 0 turns it off |
| `RECURRING_JOURNAL_RUNNER_INTERVAL_SECONDS` | no | How often recurring journals are made as their runs fall due. Default 3600; 0 turns it off |
| `CLOSE_RUNNER_INTERVAL_SECONDS` | no | How often months that have ended are checked for a close to start automatically (where an organisation turned that on). Default 3600; 0 turns it off |
| `REPORT_SCHEDULE_RUNNER_INTERVAL_SECONDS` | no | How often scheduled reports are checked for runs that are due, and sent. Default 900; 0 turns it off |
| `RECURRING_BILL_RUNNER_INTERVAL_SECONDS` | no | How often recurring vendor bills are made as their runs fall due. Default 3600; 0 turns it off |
| `RETENTION_RUNNER_INTERVAL_SECONDS` | no | How often each organisation's data retention periods are applied (SEC-020). Default 86400; 0 turns it off |
| `SSO_ALLOW_PRIVATE_NETWORKS` | no | `true` lets organisations' single sign-on providers be http:// or on private networks. Local development and tests only |
| `SSO_DNS_SERVERS` | no | DNS servers for checking sign-in domains' TXT records, comma-separated host[:port]. Default: the system's |
| `CLAMAV_URL` | recommended | A ClamAV daemon (clamd) as `tcp://host:3310`. Every upload is scanned before it is kept, and uploads are refused while it cannot answer. Empty: structural checks only |
| `CLAMAV_TIMEOUT_SECONDS` | no | Longest a scan may take. Default 15 |
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

`deploy/docker-compose.prod.yml` runs the published images on one Docker host behind Caddy (automatic TLS), with a managed MongoDB replica set and settings in `.env.production`; `.github/workflows/release.yml` deploys a version to it after an approval, running migrations first. See [`CI_CD.md`](CI_CD.md). Not done yet: a staging environment, secrets from a secrets manager rather than the host's env file, structured log shipping, and more than one host.
