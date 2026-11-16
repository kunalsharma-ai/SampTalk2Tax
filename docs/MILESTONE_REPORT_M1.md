# Milestone report — M1 functional foundation

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
* Web app (`apps/web`, second PR): sign up / sign in with an httpOnly session cookie, onboarding wizard, owner dashboard from posted journals (cash, receivables, payables, year-to-date, period chart with table, drafts), journal list / create / edit draft / post / reverse / delete draft with a live balance check, chart of accounts tree with create and edit, periods with lock/unlock and add next fiscal year, trial balance, income statement, balance sheet, general ledger, audit trail with integrity verification, members.
* `packages/ui` (accessible components) and `packages/design-system` (tokens with a WCAG contrast test).

## Tests
* `packages/accounting-engine`: 24 unit tests (incl. property test).
* `packages/security`: 6 unit tests.
* `apps/api`: 25 integration tests against PostgreSQL (tenant isolation, roles, posting, tampering, reversal races, idempotency races, numbering under concurrency, period locks, reports tie-out, audit chain, dashboard figures).
* `packages/design-system`: 2 contrast tests. `apps/web`: 3 formatting unit tests.
* `apps/web/e2e`: 10 browser tests in Chromium against the real API and database (see `TEST_STRATEGY.md`).

## Remaining in M1
* Refresh tokens and revocation, rate limiting on auth, PostgreSQL row-level security.
* Member invitations and role changes in the UI.
* Year-end close, recurring journals, dimension masters.
* Automated accessibility audit (axe) in CI.

## Blocked / needs the product owner
* Nothing blocked. Open product questions are listed in `PRODUCT_REQUIREMENTS.md` §9.

## Next implementation priorities
See `IMPLEMENTATION_ROADMAP.md` → Next priorities.
