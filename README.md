# Sampledge Talk2Tax

**Talk to Your Numbers. Automate Your Finance. Predict Your Future.**

Talk2Tax is planned as an AI-native accounting, tax and finance platform. This repository is at **Milestone 1 (backend)**: a working, tested double-entry accounting foundation. There is no web UI or AI yet. See [Status](#status).

## What works today

* **Accounts & tenants:** registration, login (scrypt + JWT), organisations with owner/admin/accountant/approver/viewer roles, strict tenant isolation.
* **Onboarding:** creating an organisation applies a starter chart of accounts and generates the current fiscal year (any start month, e.g. April–March).
* **General ledger:** hierarchical chart of accounts, draft → post journals, multi-currency lines with exchange rates, reversals, period lock/unlock, idempotent and concurrency-safe posting with gap-free numbers.
* **Reports:** trial balance, income statement, balance sheet, account ledger, all from posted entries.
* **Controls:** PostgreSQL triggers make posted entries immutable and refuse unbalanced postings even outside the API; append-only, hash-chained audit trail with a verify endpoint.
* **Demo data:** a clearly labelled synthetic Indian trading company.

## Quick start

```bash
corepack enable                      # pnpm 10
cp .env.example .env                 # set JWT_SECRET (openssl rand -base64 48)
docker compose up -d postgres
pnpm install && pnpm build
pnpm db:migrate
pnpm db:seed                         # optional, prints demo login
pnpm dev:api                         # http://localhost:4000/docs
pnpm test                            # unit + integration (needs Postgres)
```

Details: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Repository

```
apps/api                    NestJS REST API (+ seed, integration tests)
packages/accounting-engine  Pure double-entry rules (money, journals, periods, reports)
packages/database           Prisma schema and SQL migrations with integrity triggers
packages/security           Roles/permissions, password hashing
features/                   Feature registry (every directive requirement, with status)
docs/                       PRD, architecture, schema, engine, security, API, tests, roadmap
```

## Status

| | |
|---|---|
| Milestone | M1 backend complete; M1 web UI next |
| Feature registry | 1,343 requirements from the master directive; 39 Tested, 31 Implementing, 1,273 Not started — [FEATURE_STATUS.md](docs/FEATURE_STATUS.md) |
| Tests | 30 unit + 24 integration, all passing |
| Known gaps | [KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) |

## Documentation

[Product requirements](docs/PRODUCT_REQUIREMENTS.md) · [Architecture & ADRs](docs/ARCHITECTURE.md) · [Database](docs/DATABASE_SCHEMA.md) · [Accounting engine](docs/ACCOUNTING_ENGINE.md) · [API](docs/API_DOCUMENTATION.md) · [Security](docs/SECURITY.md) · [Tests](docs/TEST_STRATEGY.md) · [Roadmap](docs/IMPLEMENTATION_ROADMAP.md) · [Feature inventory](docs/FEATURE_INVENTORY.md) · [Competitive matrix (framework)](docs/COMPETITIVE_FEATURE_MATRIX.md) · [Master directive](docs/MASTER_DIRECTIVE.md)

## Updating feature status

Edit `features/status.json` (status + evidence per feature ID), then run `pnpm features:generate`. CI fails if the generated files are stale.
