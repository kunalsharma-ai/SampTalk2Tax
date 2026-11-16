# Milestone report — M1 backend foundation

Date: 2026-10-31

## Completed and tested
* Monorepo (pnpm workspaces), TypeScript build, CI workflow, Docker Compose for Postgres.
* Authentication (register/login/me), JWT, scrypt passwords.
* Tenants, memberships, five roles, 15 permissions, 404-on-non-member isolation.
* Organisation onboarding with chart template and fiscal-year generation.
* Chart of accounts CRUD with hierarchy, subtype and in-use protections.
* Fiscal periods: generation, lock/unlock with row-lock coordination.
* Journals: draft/edit/delete/post, create-and-post, idempotency keys, multi-currency, reversal.
* Database-enforced invariants (balance, immutability, period status, account state, tenant FKs, append-only audit).
* Reports: trial balance, income statement, balance sheet, account ledger.
* Hash-chained audit trail with verification.
* Synthetic demo company seed.
* Feature registry generated from all 52 directive parts (1,343 entries).

## Tests
* `packages/accounting-engine`: 24 unit tests (incl. property test).
* `packages/security`: 6 unit tests.
* `apps/api`: 24 integration tests against PostgreSQL (tenant isolation, roles, posting, tampering, reversal races, idempotency races, numbering under concurrency, period locks, reports tie-out, audit chain).

## Remaining in M1
* `apps/web`: login, registration, onboarding wizard, accounting workspace, reports, initial dashboard.
* Design system package and tokens.
* Refresh tokens, rate limiting, row-level security.

## Blocked / needs the product owner
* Nothing blocked. Open product questions are listed in `PRODUCT_REQUIREMENTS.md` §9.

## Next implementation priorities
See `IMPLEMENTATION_ROADMAP.md` → Next priorities.
