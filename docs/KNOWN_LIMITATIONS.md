# Known limitations

Honest list of what does not exist or is incomplete. Kept current with each milestone.

## Product scope
* The web app covers M1 plus the first M2 slice: customers, invoices, credit notes, receipts, receivables ageing, vendors, bills, vendor credits, payments, payables ageing, tax rates, and bank accounts with statement import, matching and reconciliation. Every other module in the directive has no screen, and the sidebar does not show them.
* Of 1,343 registry entries, the generated [`FEATURE_STATUS.md`](FEATURE_STATUS.md) lists the current counts; everything else is Not started.
* No statutory tax, payroll, procurement, expenses, treasury, FP&A, AI, agents, workflows, documents, integrations, subscriptions or admin modules yet.
* No AI functionality of any kind exists yet, and none is claimed.

## Accounting
* No year-end close (retained earnings roll-forward is shown as "unclosed earnings" on the balance sheet).
* No recurring journals, templates, accrual auto-reversal, revaluation, exchange-rate tables, intercompany, consolidation, subsidiary ledgers or cash-basis reporting.
* Dimensions are free-form key/values on lines; there are no dimension masters or dimension reports.
* The chart template is a generic SMB chart, not a statutory chart (e.g. Schedule III presentation is not implemented).
* Period CLOSED status exists but there is no close workflow; LOCKED/OPEN toggling is available to OWNER/ADMIN.

## Receivables and payables (M2, slice 1)
* Documents are in the organisation's functional currency only; multi-currency invoices and bills are not supported yet.
* Tax rates are percentages the tenant configures. There is no statutory tax engine, no place-of-supply or GST/TDS logic, no tax return and no e-invoicing.
* No quotes, sales orders, purchase orders, recurring invoices, debit notes, write-offs, bad-debt provisions, collection reminders, payment links or portals.
* No PDF generation or emailing of invoices and statements.
* Approval is role-based only (an APPROVER can post drafts); there is no multi-step approval workflow or amount thresholds.
* Removing an allocation is dated today; there is no back-dated removal.
* Ageing buckets are fixed (current, 1–30, 31–60, 61–90, over 90).

## Banking (M2, slice 2)
* Statements come from CSV files only. There is no live bank feed, no OFX/QIF/MT940/PDF import and no connection to any bank; none is claimed.
* Statement lines are in the organisation's functional currency; foreign-currency bank accounts are not supported yet.
* Matching is one statement line to one or more ledger lines. Several statement lines cannot yet be matched to one ledger line (for example a deposit the bank splits in two).
* Suggestions are rules (same amount, within 14 days, shared words). They do not learn from past matches, and no AI is involved.
* Ledger lines dated before the first reconciliation period are treated as already cleared unless a later statement line matches them, so a cheque issued before that date and still outstanding has to be matched or will show as a difference.
* Only the latest reconciliation of an account can be undone. Transfers between two of your own bank accounts are booked as an entry on each side; there is no transfer detection.
* Excluded lines must be real non-movements (for example a duplicate in the bank's file); excluding a genuine movement will make the statement total disagree.

## Attachments and approvals (M2, slice 3)
* Files are stored inside PostgreSQL (up to 5 MB each, 20 per record). That is fine for evidence at this scale; object storage is planned before larger volumes. Uploaded files are not scanned for malware; they are only served as downloads or in a sandbox.
* No OCR or extraction: a file is evidence attached to a record, nothing is read from it. No standalone document vault, folders or search.
* Bank statement lines accept attachments through the API, but the banking screens do not show them yet.
* Approvals are single-step: one approver per document, one rule per document type with a minimum total. No multi-level chains, approval by department or vendor, escalations, delegation or notifications. Payments and manual journals have no approval rules yet.
* An approval is tied to the exact total; any edit to the draft cancels it. A changed tax rate that alters the total also needs a new approval.

## Web app
* One dashboard chart (revenue, expenses and net income by period, with a table). No drill-down, filters, forecasts or other dashboards.
* Journal entry is a form with line rows, not a spreadsheet-style grid; no CSV import, attachments, templates or recurring entries.
* No global search, command palette, notifications, light theme (the app has one dark theme) or per-user locale setting.
* Layouts are responsive, but there is no automated accessibility audit (axe) or visual regression test yet.
* Member screen adds existing users by email; there are no invitation emails or role changes in the UI.

## Security
* Access tokens only (no refresh or server-side revocation). Signing out clears the web session cookie, but the token stays valid until it expires (1 h by default). No MFA/SSO; no rate limiting or lockout on login.
* Tenant isolation is enforced in the application and by composite foreign keys; PostgreSQL row-level security is not enabled yet.
* Members are added by existing email only; no invitation emails.
* Segregation of duties (creator ≠ poster) is possible through roles but not enforced as a policy.

## Engineering
* Dependency majors are pinned below the newest releases (TypeScript 5.9 vs 7, NestJS 11 vs 12, Prisma 6 vs 7/8). See ADR-005.
* Audit appends serialise per organisation with an advisory lock; fine for current volume, to be revisited under load.
* The Docker image and compose `app` profile are written but have not been built in CI.
* Performance targets in the directive have not been benchmarked.
* `docs/COMPETITIVE_FEATURE_MATRIX.md` is a framework; competitor capabilities have not been researched or verified yet.

## Documents from Directive Part 48 not written yet
`TAX_ENGINE.md`, `AI_AGENT_ARCHITECTURE.md`, `AI_SAFETY_AND_GOVERNANCE.md`, `FINANCIAL_DIGITAL_TWIN.md`, `WORKFLOW_ENGINE.md`, `INTEGRATION_ARCHITECTURE.md`, `DESIGN_SYSTEM.md`, `DASHBOARD_SPECIFICATIONS.md`, `PRICING_STRATEGY.md`. They will be written with the milestone that builds each area rather than as speculative stubs.
