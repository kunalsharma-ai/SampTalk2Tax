# Test strategy

## Layers

| Layer | Tool | Where | Runs against |
|---|---|---|---|
| Unit | vitest | `packages/*/test` | Pure functions |
| Property | vitest + seeded PRNG | `accounting-engine/test/reports.test.ts` | 300 random balanced journals |
| API integration | vitest + supertest + Nest app | `apps/api/test/*.e2e.test.ts` | Real PostgreSQL (`TEST_DATABASE_URL`) |
| Web unit | vitest | `apps/web/test` | Money formatting |
| Design tokens | node:test | `packages/design-system/test` | WCAG AA contrast of every text/background pair |
| End-to-end UI | Playwright + node:test | `apps/web/e2e` | Real browser → web app → API → PostgreSQL |
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
| Subledger = control account | `ageing ties to the receivables control account, today and on earlier dates`; payables ageing in `posts a bill to payables…` |
| Document totals | engine property test: total = Σ rounded lines = subtotal + tax for random documents |
| No over-allocation | API refusal plus `rejects over-allocation inserted directly in SQL`; 10 concurrent receipts against one invoice → exactly the ones that fit |
| Control accounts | `keeps receivables and payables out of manual journals, in the API and in the database` |
| Void preserves history | `voids only after allocations are removed, and posts an exact reversal` |

## Browser end-to-end tests

`apps/web/e2e/ledger-flow.test.mjs` signs up a new user and walks the M1 flow in Chromium: signed-out redirect, registration and onboarding, an unbalanced journal that the form refuses, posting once it balances, the trial balance and dashboard reflecting the posting, reversing it, adding an account (and the server refusing a duplicate code), locking a period so posting fails and unlocking it, verifying the audit chain, the proxy refusing writes without the CSRF header, and no unexpected console errors. Responses the test provokes on purpose (409, 403, 404) are removed from the console check only for those steps.

`apps/web/e2e/sales-flow.test.mjs` walks the M2 flow: adding a tax rate (defaults to the template tax accounts), writing an invoice with a customer created from the form and a live total, posting it, recording a part receipt from the invoice with "allocate oldest first", the ageing tying to the ledger, manual journals not offering the control accounts, a duplicate vendor invoice number being refused, and voiding the invoice only after its receipt is removed.

Not yet covered (no feature yet): tax, payroll, reconciliation, AI agent evaluation, prompt injection, workflow recovery, automated accessibility audits (axe), visual regression, load.

## Running

```bash
pnpm test                               # everything (needs Postgres + TEST_DATABASE_URL)
pnpm --filter @talk2tax/accounting-engine test   # engine only, no database
pnpm e2e                                # browser tests; needs the API on :4000 and the web app on :3000
```

Set `WEB_URL` to test another address, and `E2E_SCREENSHOTS=<dir>` to save screenshots.

CI (`.github/workflows/ci.yml`) runs build, typecheck, all tests against a Postgres service, starts the API and web app and runs the browser tests, and checks the feature registry is regenerated.
