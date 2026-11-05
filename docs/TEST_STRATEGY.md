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

Departments and projects (M6 slice 3): engine tests (`packages/accounting-engine/test/dimensions.test.ts`, 3) cover code rules and the profit split with Not assigned, zero rows dropped and margins; a journal engine test checks the tags pass through to lines and reversals. `apps/api/test/dimensions.e2e.test.ts` (6) covers adding values with per-kind codes, permissions, tag checks by kind, organisation and active state, invoice tags carried to the journal, the profit by department and project, the income statement for one department, reversals keeping tags of an inactive value, and the database guards. `apps/web/e2e/dimensions-flow.test.mjs` adds values, tags a journal on the form, reads the report and the filtered profit and loss, and makes a department inactive.

Loans and treasury (M6 slice 4): engine tests (`packages/accounting-engine/test/loans.test.ts`, 8) cover the EMI formula, schedules that clear exactly, equal principal, keeping the installment after a prepayment, an installment that does not cover interest, due dates at month ends, the 12-month split and term checks. `apps/api/test/loans.e2e.test.ts` (8) covers adding a loan with its disbursement journal, validation, installments as scheduled and as the lender charged them, date order, rate changes both ways and their reversal, prepayment with charges, latest-only reversal, closing and reopening a loan, the treasury overview and ledger check, permissions, tenant isolation and the database guards. `apps/web/e2e/loans-flow.test.mjs` adds a loan with the live schedule, records installments, changes and reverses the rate, prepays and reads the treasury page.

Invoice templates and e-signatures (M6 slice 5): engine tests (`packages/accounting-engine/test/invoice-templates.test.ts`, 28) cover amounts in words (lakh/crore and international, zero-decimal currencies, rounding), Indian and international digit grouping, date styles, the placeholder language (escaping, lists, inverted sections, refusing unescaped and broken tags, no inherited properties), the HTML checks (scripts, handlers, `javascript:`, frames, forms, page shells, network loads, line numbers, unknown placeholders), every preset building a layout that passes its own rules, country and contrast warnings, layout normalising and refusals, the India tax summary, rendering every preset in every theme with no script and the strict policy, escaping of data and typed section text, hidden and paired sections, draft/void stamps, the signature block, HTML templates, the canonical signed content and image sniffing. `apps/api/test/invoice-templates.e2e.test.ts` (17) covers the built-in template, presets and the first default, saving a customised layout with warnings and refusals, HTML templates and unsafe code, logos (SVG, bad base64, size), duplicate, default and archive rules, print data with default, chosen and per-invoice templates on a posted invoice, the HTML page and its headers, purchase documents and tenant isolation, permissions, saving and replacing signatures, signing only posted invoices, the recorded hash and its verification, the signed copy surviving a new signature, withdrawal rules, a voided invoice after signing and the database guards. `apps/web/e2e/invoice-templates-flow.test.mjs` creates a template from a preset with a theme and palette, edits colours, section text, order and a column in the designer and saves, writes an HTML template and sees an event handler refused, draws and saves a signature, prints a posted invoice with each template, sets one on the invoice, signs it and withdraws the signature, reading the invoice inside its sandboxed frame.

Report exports (M6 slice 6): engine tests (`packages/accounting-engine/test/report-export.test.ts`, 10) cover the model checks, file names, CSV formula neutralising, quoting and layout, CRC-32, Excel date serials, the stored ZIP, workbook cells and styles, lakh and crore format bands and XML-unsafe characters; the workbook was also opened in LibreOffice to check the formatted figures. `apps/api/test/report-exports.e2e.test.ts` (8) checks CSV figures against the JSON report, headers and the SHA-256, CSV and Excel against formula injection, Excel number formats, PDF text, page size and orientation, the general ledger and profit by department, refusals, permissions, tenant isolation and the audit entry. `apps/web/e2e/report-exports-flow.test.mjs` downloads files from four report pages, reads them back, and sees a bad range refused on screen.

Group consolidation (M6 slice 7): engine tests (`packages/accounting-engine/test/consolidation.test.ts`, 7) cover combining by code, eliminations, mismatches, missing accounts, translation with the reserve, earnings brought forward and refusals. `apps/api/test/consolidation.e2e.test.ts` (9) covers groups, who may add a company, rates for a USD member, rules checked against each member, translated and eliminated figures, a mismatch, report access in every member, exports with the audit, and removing members. `apps/web/e2e/consolidation-flow.test.mjs` sets up a group and a rule on screen, checks the worksheet, statements and a difference, and exports the worksheet, then sets 60% ownership and checks the non-controlling interests (slice 8; engine tests for the outside share, rounding and ownership checks, and an API test for ownership changes and the split lines in exports).

Intercompany transactions (M6 slice 9): engine tests for netting charges, settlements and reversals by period and for exact eliminations across currencies; `apps/api/test/intercompany.e2e.test.ts` (9) covers intercompany accounts against each chart and against elimination rules, charges and settlements in both companies, two currencies, nothing posted when the second company's period is locked, posting rights in both companies, exact eliminations, reversal of both entries, and the guards on removing members or the group; `apps/web/e2e/intercompany-flow.test.mjs` sets the accounts, posts a charge and a settlement, checks the eliminations, opens the posted entry and reverses the charge.

Digital twin (M7 slice 1): `packages/accounting-engine/test/twin.test.ts` (9) covers the no-change baseline, growth with cost of sales following volume and cash tied up in receivables, pricing, hiring with a loan and equipment, EMI interest on the reducing balance, running out of cash with the cash needed and a loss, churn, currency, inflation, payment terms, expansion and one-off items, the tax rate taken from history, and validation in words; `apps/api/test/twin.e2e.test.ts` (5) covers the baseline from posted journals, simulation without saving, saving with permissions and duplicate names, comparison, tenant isolation, audit, and that no journal is written; `apps/web/e2e/twin-flow.test.mjs` starts from the Hire a team template, edits it and checks the projection, adds the tax rate it asks for, saves, reopens, changes the horizon, compares with no change and checks the journal count is unchanged.

Scenario war room (M7 slice 2): `packages/accounting-engine/test/twin-insights.test.ts` (4) covers marginal impacts and interaction, departments, sized funding and when suggestions appear; `apps/api/test/war-room.e2e.test.ts` (5) covers impacts by department and refusing another organisation's department, versions and restore, notes with pins and who may resolve or delete, the approval flow (frozen states, no self-approval, rejection needs a reason, reopen), audit and tenant isolation; `apps/web/e2e/war-room-flow.test.mjs` drives an owner and an approver in two browsers through impacts, a suggested loan, notes, restores, rejection, approval, the planning board and the risk map.

Recovery planner (M7 slice 3): `packages/accounting-engine/test/recovery.test.ts` (6) covers the no-action summary, every option and its measured effect, recoverable debt and the people to talk to, loan sizing, which options need a decision, plan forecasts and a healthy business; `apps/api/test/recovery.e2e.test.ts` (6) covers options from real invoices, bills and journals, plans and actions with permissions, owners who must be members, dropped actions leaving the forecast, plan status rules, copying into a twin scenario, tenant isolation, audit, and that no journal, payment or loan is created; `apps/web/e2e/recovery-flow.test.mjs` runs the whole flow in the browser.

Virtual CFO (M7 slice 4): `packages/accounting-engine/test/cfo.test.ts` (17) covers the health score and its rules, every area's figures and verdicts, cost increases, an empty organisation, all nine questions and the AI summary figure check; `apps/api/test/cfo.e2e.test.ts` (13) covers the assessment and every question from real invoices, bills and journals, permissions, tenant isolation, packs (one per kind a month, commentary, refresh, finalise, the database refusing changes to a final pack), the AI guard, a summary rejected by the figure check and one kept (scripted model), the AI control center and activity log, the audit trail, the copilot's CFO tools, and that nothing is posted; `apps/web/e2e/cfo-flow.test.mjs` runs the whole flow in the browser against the Anthropic stand-in.

Benchmarking (M7 slice 5): `packages/accounting-engine/test/benchmark.test.ts` (7) covers the ten metrics, thresholds, banded counts, positions, peer-group fallback and that no single value is returned; `apps/api/test/benchmarking.e2e.test.ts` (9) covers consent and permissions, the pool's contents, RLS keeping tenants out of the pool, suppression, live and synthetic pools kept apart, refresh, withdrawal and rejoining under a new key, and the audit trail; `apps/web/e2e/benchmarking-flow.test.mjs` runs the whole flow in the browser with five real peer organisations.

Relationship explorer and figure tracing (M7 slice 6): `apps/api/test/graph.e2e.test.ts` (8) covers search, the explained connections of a customer, invoice, receipt, journal entry, account, project and alert, permissions and tenant isolation, and the source of each general ledger line; `apps/web/e2e/knowledge-graph-flow.test.mjs` walks from a customer to its invoice and traces a profit and loss line to the ledger, the invoice and back.

Decision memory (M7 slice 7): `packages/accounting-engine/test/decisions.test.ts` (5) covers outcome checks, explanations, changes and the suggested verdict; `apps/api/test/decisions.e2e.test.ts` (6) covers measuring outcomes from the books against the month before, validation, search, editing, review freezing the figures, the database lock on reviewed decisions, drafts from approved scenarios and recovery plans, permissions, tenant isolation and audit; `apps/web/e2e/decision-memory-flow.test.mjs` records, reviews, searches, records a recovery plan and withdraws it in the browser.

Forecast evaluation lab: `packages/accounting-engine/test/forecast-lab.test.ts` (4) covers each method, the accuracy measures, the rolling origin and ranking; `apps/api/test/forecast-lab.e2e.test.ts` (3) covers backtests on twelve months of books, saving a run, measuring an older run against the books, the database lock on saved runs, audit, permissions and tenant isolation; `apps/web/e2e/forecast-lab-flow.test.mjs` runs the lab and saves a run in the browser.

Disaster simulation: `packages/accounting-engine/test/disaster.test.ts` (6) checks each shock's figures by hand, shocks together, validation and the standard stress tests; `apps/api/test/disasters.e2e.test.ts` (5) covers figures from posted invoices and bills, simulation, validation, stress tests, saving, copying to the twin, audit, no postings, permissions and tenant isolation; `apps/web/e2e/disaster-simulation-flow.test.mjs` runs, saves, extends, copies and deletes a simulation in the browser.

Policy studio: `packages/accounting-engine/test/policies.test.ts` (3) checks rule and test validation, test results with actual values and rules in words; `apps/api/test/policies.e2e.test.ts` (11) covers checking without saving, saving, back-tests against posted bills, the self-approval, accountant and failing-test blocks, approval into workflows and later versions, retiring, audit, immutable versions, AI drafts with a scripted model counted in the AI control center, AI off or not set up, permissions and tenant isolation; `apps/web/e2e/policy-studio-flow.test.mjs` writes, tests, back-tests, approves and retires a policy in the browser with two users.

Dashboards: `packages/accounting-engine/test/dashboards.test.ts` (3) checks validation, every widget's figures by hand and dashboards in words; `apps/api/test/dashboards.e2e.test.ts` (4) covers figures from posted documents, earlier months, saving, changing and deleting with audit, AI drafts with a scripted model counted in the AI control center, permissions and tenant isolation; `apps/web/e2e/dashboards-flow.test.mjs` builds, previews, saves, changes and deletes a dashboard in the browser.

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

Integrations: `apps/api/test/integrations.e2e.test.ts` (6) covers owner-and-admin-only access, encryption at rest and no secret in responses or the audit trail, AI key tests through the official SDK against the local stand-in (rejected and working), the copilot using the organisation's own key and model, switching off, a mail server test with a refused login and a real test email, automations sending through the organisation's server, removal, a secret sealed with another key, the server fallback, and the private-network and unencrypted refusals; `apps/web/e2e/integrations-flow.test.mjs` sets up and tests both in the browser.
