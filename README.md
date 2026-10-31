# Sampledge Talk2Tax

**Talk to Your Numbers. Automate Your Finance. Predict Your Future.**

Talk2Tax is planned as an AI-native accounting, tax and finance platform. This repository is at **Milestone 1**: a working, tested double-entry accounting foundation with a web app on top of it. There is no AI yet. See [Status](#status).

## What works today

* **Accounts & tenants:** registration, login (scrypt + JWT), organisations with owner/admin/accountant/approver/viewer roles, strict tenant isolation.
* **Onboarding:** creating an organisation applies a starter chart of accounts and generates the current fiscal year (any start month, e.g. April–March).
* **General ledger:** hierarchical chart of accounts, draft → post journals, multi-currency lines with exchange rates, reversals, period lock/unlock, idempotent and concurrency-safe posting with gap-free numbers.
* **Reports:** trial balance, income statement, balance sheet, account ledger, all from posted entries.
* **Controls:** PostgreSQL triggers make posted entries immutable and refuse unbalanced postings even outside the API; append-only, hash-chained audit trail with a verify endpoint.
* **Receivables & payables (M2, first slice):** customers and vendors, tenant tax rates, invoices, credit notes, bills and vendor credits (draft → post → void), receipts and payments with allocation and idempotency, credit limits, duplicate vendor-invoice detection, customer/vendor statements, and ageing that reconciles to the control accounts.
* **Banking (M2, second slice):** bank and cash accounts, CSV statement import with column detection and duplicate skipping, rule-based match suggestions, receipts, payments or entries created straight from statement lines, and bank reconciliation with locked periods, history and undo. No live bank feeds.
* **Attachments and approvals (M2, third slice):** PDF and image files attached to invoices, bills, payments and journals (type checked from the bytes, kept unchanged, removal leaves a record), and approval rules by document type and amount that the database enforces: a covered draft posts only after someone other than its preparer approves exactly that total. Editing a draft cancels its approval.
* **Expense claims (M2, fourth slice):** a new Employee role that only sees its own claims; claims with tax-inclusive receipt amounts, receipts attached, submit, approve (by someone other than the claimant, which posts Dr expenses and input tax / Cr employee reimbursements payable) and pay back from a bank account. Duplicate and missing-receipt warnings.
* **Web app:** sign up and sign in, an onboarding wizard, an owner dashboard computed from posted journals, journal entry with a live balance check, chart of accounts, periods with lock/unlock, the four reports, the audit trail with an integrity check, members, the sales, purchases, banking and tax-rate screens, an approvals inbox, approval rules, and expense claims.
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
pnpm dev:web                         # http://localhost:3000
pnpm test                            # unit + integration (needs Postgres)
pnpm e2e                             # browser tests (API and web app running)
```

Details: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Repository

```
apps/api                    NestJS REST API (+ seed, integration tests)
apps/web                    Next.js web app (+ Playwright browser tests)
packages/ui                 Accessible React components
packages/design-system      Colour and type tokens with a contrast test
packages/accounting-engine  Pure double-entry rules (money, journals, periods, reports)
packages/database           Prisma schema and SQL migrations with integrity triggers
packages/security           Roles/permissions, password hashing
features/                   Feature registry (every directive requirement, with status)
docs/                       PRD, architecture, schema, engine, security, API, tests, roadmap
```

## Status

| | |
|---|---|
| Milestone | M1 built; M2 slices 1 (receivables and payables), 2 (banking and reconciliation) 3 (attachments and approvals) and 4 (expense claims) built; M2 core scope complete, hardening next |
| Feature registry | 1,343 requirements from the master directive; 101 Tested, 30 Implemented, 29 Implementing, 1,183 Not started — [FEATURE_STATUS.md](docs/FEATURE_STATUS.md) |
| Tests | 69 unit + 88 integration + 38 browser end-to-end, all passing |
| Known gaps | [KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) |

## Documentation

[Product requirements](docs/PRODUCT_REQUIREMENTS.md) · [Architecture & ADRs](docs/ARCHITECTURE.md) · [Database](docs/DATABASE_SCHEMA.md) · [Accounting engine](docs/ACCOUNTING_ENGINE.md) · [API](docs/API_DOCUMENTATION.md) · [Security](docs/SECURITY.md) · [Tests](docs/TEST_STRATEGY.md) · [Roadmap](docs/IMPLEMENTATION_ROADMAP.md) · [Feature inventory](docs/FEATURE_INVENTORY.md) · [Competitive matrix (framework)](docs/COMPETITIVE_FEATURE_MATRIX.md) · [Master directive](docs/MASTER_DIRECTIVE.md)

## Updating feature status

Edit `features/status.json` (status + evidence per feature ID), then run `pnpm features:generate`. CI fails if the generated files are stale.
