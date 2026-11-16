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

Schedules and email (M5 slice 2): `apps/api/test/workflow-schedules.e2e.test.ts` (9 tests) delivers real SMTP through nodemailer to a local SMTP server (`test-support/smtp-stand-in.mjs`, which keeps and decodes what it accepts) and drives the runner with a chosen clock: an invoice reminder that reaches only invoices that hit 3 days overdue from the day it was turned on, once each (paid and older invoices left alone, the next one picked up "tomorrow", nothing repeated after turning off and on); the email as received (₹ grouping, dates, footer, headers); a customer with no address failing that action only; a 451 answer retried and a 550 answer ending the delivery, then sent again by hand; test emails to the tester only; a bill due in 5 days emailing a member with a link; a daily digest that waits for the first time after it was turned on, with receivables and payables figures, once per occurrence; the database refusing a second run for one occurrence; and email not set up. `apps/web/e2e/automations-schedule-email.test.mjs` builds an overdue reminder in the builder, tests it (the test email goes to the owner only), turns it on and waits for the running API to email the customer through the local SMTP server, then builds a weekly digest and checks its next time. The API under test needs `SMTP_URL=smtp://127.0.0.1:4556`; the browser test starts the SMTP server on that port. Engine tests cover schedule maths in India time (week and month boundaries, just after midnight), due-date windows and amount formatting.

AI collections agent (M5 slice 3): `apps/api/test/collections.e2e.test.ts` (14 tests) drafts with a scripted model and sends real SMTP to the local SMTP server: no key, AI off and permissions; the facts and forced tool sent to the model; customers left out (no email, waiting, reminded recently); checks refusing an invented amount, a foreign invoice number and a missing invoice; sending with edits once; database guards on a sent reminder; refusal of a reminder the books have moved past; rejection; email not set up; a refusal, a malformed submission and a rate limit; one run at a time; a 550 answer then a resend as approved; a run interrupted by a restart; and the AI activity log. `apps/web/e2e/collections-flow.test.mjs` uses the real SDK against the Messages API stand-in (4555) and SMTP (4556): draft, see the customer left out, catch a wrong amount as it is typed, fix and send, and find the call in AI activity. Engine tests cover the facts and every check.

AI reconciliation (M5 slice 4): `apps/api/test/bank-ai.e2e.test.ts` (10 tests) uses a scripted model that picks references out of the text it is sent: no key, AI off and permissions; references and never ids, no bank or control accounts offered; a line with an exact match left out; a receipt split over two invoices, a deposit matched to two receipts and an entry, each accepted through the by-hand code; "cannot tell" and an over-allocated bill refused; dismissal; database guards; the next run shown the accepted entry as an example; a suggestion refused after its line was excluded; a refusal, a rate limit and one run at a time; the AI activity log. `apps/web/e2e/bank-ai-flow.test.mjs` accepts an AI receipt (the invoice is paid and the line matched) and dismisses an AI entry through the real SDK against the stand-in. Engine tests cover every check and the text the model reads.

AI control center (M5 slice 6): `apps/api/test/ai-control.e2e.test.ts` (8 tests) checks:

* the overview and action levels;
* who may look and who may change;
* validation;
* an agent switched off refusing before anything is sent;
* a monthly budget stopping a collections run part-way and refusing the next run;
* usage kept separate per organisation;
* acceptance rates from decisions;
* the emergency stop pressed while a reminder is being drafted, which stops the rest of the run, shows the reason in collections and copilot refusals and is audited;
* resuming;
* a stop during a month-end review, which keeps the usage and drops the proposals.

`apps/web/e2e/ai-control-flow.test.mjs` drives the page in the browser.

Fixed assets (M6 slice 1): engine tests (`packages/accounting-engine/test/fixed-assets.test.ts`, 10) cover straight-line rounding into the last month, opening depreciation, posted amounts, written-down value resetting at the fiscal year, the residual floor, charges through the disposal month and none after, and the disposal entry. `apps/api/test/fixed-assets.e2e.test.ts` (9) covers adding assets with and without the purchase posted, validation, permissions, a run's journal, catch-up of a skipped month, fixed terms, latest-first reversal, disposal with a loss and its preconditions, and the database guards. `apps/web/e2e/fixed-assets-flow.test.mjs` drives purchase to disposal in the browser.

Prepaid, deferred revenue and accruals (M6 slice 2): engine tests (`packages/accounting-engine/test/deferrals.test.ts`, 9) cover end dates, even releases with rounding into the last month, day-based releases for part months without drift, posted amounts with catch-up, ending early, release directions and term checks. `apps/api/test/deferrals.e2e.test.ts` (12) covers adding schedules with the payment or receipt posted, validation, permissions, the close checklist warning, a run's journal with catch-up, fixed terms, latest-first reversal, ending early with a refund, tenant isolation, accruals with their automatic reversal and cancellation, and the database guards. `apps/web/e2e/deferrals-flow.test.mjs` drives schedules, releases, ending early and an accrual in the browser.

Month-end close (M5 slice 5): `apps/api/test/close.e2e.test.ts` (11 tests) builds real books (rent in three earlier months but not the month, equipment, sales, a draft journal and an unmatched bank line). It checks:

* the checklist and tasks made once;
* no key, AI off and permissions;
* what the scripted model is shown;
* four proposed entries, two failing their checks;
* an accrual posted with its reversal through the journal code;
* rejection and database guards;
* closing refused, then closed with a note: the period is locked, unlocking it is refused, and the certification totals are right;
* reopening and reversing a posted adjustment;
* a refusal, a rate limit and one review at a time;
* the AI activity log.

`apps/web/e2e/close-flow.test.mjs` runs the whole flow in the browser through the real SDK against the stand-in. Engine tests cover every check and the text the model reads.

Not yet covered (no feature yet): tax, payroll, reconciliation, AI agent evaluation, prompt injection, automated accessibility audits (axe), visual regression, load.

## Running

```bash
pnpm test                               # everything (needs Postgres + TEST_DATABASE_URL)
pnpm --filter @talk2tax/accounting-engine test   # engine only, no database
pnpm e2e                                # browser tests; needs the API on :4000 and the web app on :3000
```

Set `WEB_URL` to test another address, and `E2E_SCREENSHOTS=<dir>` to save screenshots.

CI (`.github/workflows/ci.yml`) runs build, typecheck, all tests against a Postgres service, starts the API and web app and runs the browser tests, and checks the feature registry is regenerated.
