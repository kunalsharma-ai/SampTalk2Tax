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
| Bank statement = books | `completes when the ledger less uncleared items equals the statement, and freezes the lines`; engine `reconciliation` tests |
| One ledger line, one bank line | partial unique index; two concurrent matches of the same ledger line → exactly one succeeds |
| Statement import is exact and idempotent | engine amount/date parsing (no floats); re-importing an overlapping file adds only new lines |
| Evidence files are kept unchanged | `removes a file with a reason but keeps the record, and the bytes cannot be changed` (direct SQL UPDATE/DELETE refused) |
| Only approved documents post | `blocks posting a covered bill until someone else approves it`; direct SQL status change refused |
| Approver ≠ preparer | `refuses an approval from the person who prepared the bill`, in the API and in SQL |
| Approval matches what posts | `cancels an approval when the draft changes, so only what was approved can post` |
| Expense approver ≠ claimant | `never lets someone approve their own claim, even in SQL` |
| Employee sees nothing of the books | `the Employee role › sees what it needs to claim expenses and nothing of the books` |
| Expense claims post and clear | `is approved and posted to expenses, input tax and the amount owed to the employee`; `is reimbursed from a bank account, which clears what is owed` |
| Tax-inclusive split | engine `splits the tax out of tax-inclusive amounts, half-even` |
| Void preserves history | `voids only after allocations are removed, and posts an exact reversal` |

## Tenant isolation below the application

`apps/api/test/row-level-security.e2e.test.ts` skips the application's own filters, as a bug would: unfiltered queries, another tenant's id, raw SQL, inserts and updates aimed at another organisation, a stray root-client call inside a transaction, and a service patched to ignore its `orgId` during a real HTTP request. PostgreSQL must return only the caller's rows and refuse the writes. It also checks every `org_id` table has row security enabled and forced, and that the API's role cannot bypass it.

## Browser end-to-end tests

`apps/web/e2e/ledger-flow.test.mjs` signs up a new user and walks the M1 flow in Chromium: signed-out redirect, registration and onboarding, an unbalanced journal that the form refuses, posting once it balances, the trial balance and dashboard reflecting the posting, reversing it, adding an account (and the server refusing a duplicate code), locking a period so posting fails and unlocking it, verifying the audit chain, the proxy refusing writes without the CSRF header, and no unexpected console errors. Responses the test provokes on purpose (409, 403, 404) are removed from the console check only for those steps.

`apps/web/e2e/sales-flow.test.mjs` walks the M2 flow: adding a tax rate (defaults to the template tax accounts), writing an invoice with a customer created from the form and a live total, posting it, recording a part receipt from the invoice with "allocate oldest first", the ageing tying to the ledger, manual journals not offering the control accounts, a duplicate vendor invoice number being refused, and voiding the invoice only after its receipt is removed.

`apps/web/e2e/banking-flow.test.mjs` imports a bank-style CSV (columns detected from the header), shows that re-importing adds nothing, records a customer receipt from a money-in line, posts bank charges from a money-out line, excludes a duplicate, and reconciles the account (first with a wrong closing balance, then the right one), after which the lines are locked.

`apps/web/e2e/approvals-flow.test.mjs` sets a rule for bills, attaches a PDF to a draft bill (and sees a fake PDF refused), checks the download is byte-identical and sandboxed, submits the bill, shows that its preparer cannot approve it, then signs in as a second person with the Approver role who approves and posts it.

`apps/web/e2e/expenses-flow.test.mjs` signs in an employee who sees only "My expense claims", writes a two-line claim with a tax-inclusive amount and live totals, attaches a receipt and submits it; the owner approves it (posting it) and pays it back from the bank; the employee then sees it paid, without links into the books.

`apps/web/e2e/members-flow.test.mjs` creates an invite link, opens it signed out, creates the invited account from the link and joins with the role; the owner changes the role, is stopped from demoting the only owner, removes the member (who then loses access), and a link opened with a different account is refused.

`apps/web/e2e/security-flow.test.mjs` signs one account in on two browsers, deletes the expired access cookie and sees the page load anyway (the refresh token was rotated), signs the phone out from the laptop's Security page, changes the password (signing the phone out again), checks that a copied access token stops working after sign-out, and sees the lockout message after five wrong passwords.

`apps/web/e2e/copilot-flow.test.mjs` turns the AI copilot on, asks a question answered from the real profit and loss (with a table and a linked source), sees a provider rate-limit error explained, asks again, deletes the conversation and turns the copilot off. The API must run with `ANTHROPIC_API_KEY` set to any value and `ANTHROPIC_BASE_URL=http://127.0.0.1:4555`: the test starts a local stand-in for Anthropic's Messages API there (`test-support/anthropic-stand-in.mjs`) and scripts its replies, so the real SDK, streaming included, is exercised without a key or network. The API tests never reach a provider: `bootApp` clears the key.

`apps/web/e2e/automations-flow.test.mjs` builds a workflow in the builder (a refused ftp:// address is explained), tests it on a real invoice without creating anything, turns it on, and waits for the running API to act on the next large invoice: a run marked Done with its conditions and webhook answer, a skipped run for a small invoice, a webhook received by a local receiver whose signature checks out with the secret shown on the page, and a task that is worked to done with a note; then the threshold is changed and the new version is listed. `apps/api/test/workflows.e2e.test.ts` (11 tests) drives the runner by hand, as the server does (outside any request), against a real local webhook receiver: validation that lists every problem, dry-run tests, acting only after being turned on, tasks by role and person, signatures, a 503 retried after a minute then a 410 ending the delivery, retry by hand, six refused connections ending a delivery, versions and stale edits, every trigger's facts from real records, a task for a member who left, task permissions, and database guards and row-level security. `apps/api/test/webhook.test.ts` covers signing, private and reserved addresses (including IPv4-mapped IPv6), timeouts and redirects.

Not yet covered (no feature yet): tax, payroll, reconciliation, AI agent evaluation, prompt injection, automated accessibility audits (axe), visual regression, load.

## Running

```bash
pnpm test                               # everything (needs Postgres + TEST_DATABASE_URL)
pnpm --filter @talk2tax/accounting-engine test   # engine only, no database
pnpm e2e                                # browser tests; needs the API on :4000 and the web app on :3000
```

Set `WEB_URL` to test another address, and `E2E_SCREENSHOTS=<dir>` to save screenshots.

CI (`.github/workflows/ci.yml`) runs build, typecheck, all tests against a Postgres service, starts the API and web app and runs the browser tests, and checks the feature registry is regenerated.
