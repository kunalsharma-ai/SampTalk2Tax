# Test strategy

## Layers

| Layer | Tool | Where | Runs against |
|---|---|---|---|
| Unit | vitest | `packages/*/test` | Pure functions |
| Property | vitest + seeded PRNG | `accounting-engine/test/reports.test.ts` | 300 random balanced journals |
| API integration | vitest + supertest + Nest app | `apps/api/test/*.e2e.test.ts` | Real PostgreSQL (`TEST_DATABASE_URL`) |
| End-to-end UI | Playwright | planned with `apps/web` | |
| Load | k6 | planned (PERF targets) | |

Integration tests never drop or reset data. Each test registers its own users and creates its own organisations, so runs are isolated by tenant and can repeat against the same database. Global setup only runs `prisma migrate deploy`, and refuses a database URL that does not contain "test".

## Financial invariants covered (Directive Part 42)

| Scenario | Test |
|---|---|
| Every journal balances | engine `rejects an unbalanced entry`; API `refuses an unbalanced posted entry even if inserted directly in SQL` |
| Reversals preserve history | `reverses a posted entry exactly once and nets it to zero`; posted rows immutable |
| Locked periods reject postings | `blocks posting into a locked period and allows it again after unlock` |
| Currency conversion rate and precision | engine FX tests; API `converts foreign-currency lines` |
| Trial balance reconciles | `produce a balanced trial balance and statements that tie out` |
| Statements reconcile to the ledger | same; ledger closing balance = TB balance |
| Duplicate requests do not duplicate postings | idempotency tests incl. 8 concurrent retries |
| Concurrent operations stay consistent | 25 concurrent posts get numbers 1..25; 6 concurrent reversals → exactly one |
| Tenant isolation | `never exposes or accepts another tenant’s data` |
| Permissions | `enforces role permissions per organization` |
| Tampering | direct SQL UPDATE/DELETE on posted lines, entries and audit events all fail |

Not yet covered (no feature yet): tax, payroll, reconciliation, AI agent evaluation, prompt injection, workflow recovery, accessibility, visual regression, load.

## Running

```bash
pnpm test                               # everything (needs Postgres + TEST_DATABASE_URL)
pnpm --filter @talk2tax/accounting-engine test   # engine only, no database
```

CI (`.github/workflows/ci.yml`) runs build, typecheck, all tests against a Postgres service, and checks the feature registry is regenerated.
