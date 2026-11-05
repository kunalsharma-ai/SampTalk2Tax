# Feature status

_Generated. Source of truth: `features/status.json` (status + evidence) merged into `features/registry.json`._

A feature counts as **Implemented** only when its business logic, persistence, API **and UI** work. Backend-complete features without UI are reported as **Implementing** with evidence, never as Implemented.

## Summary

| Status | Count |
|---|---|
| Not started | 918 |
| Designed | 0 |
| Implementing | 61 |
| Implemented | 32 |
| Tested | 321 |
| Integration pending | 11 |
| External approval required | 0 |
| Blocked | 0 |
| Production ready | 0 |
| **Total** | **1343** |

## By module

| Module | Milestone | Entries | Not started | In progress or later |
|---|---|---|---|---|
| Competitive benchmarking | M0 | 49 | 49 | 0 |
| General ledger and accounting engine | M1 | 44 | 13 | 31 |
| Accounts receivable | M2 | 43 | 30 | 13 |
| Accounts payable | M2 | 36 | 25 | 11 |
| Banking and reconciliation | M2 | 24 | 7 | 17 |
| Global taxation engine | M3 | 54 | 31 | 23 |
| Payroll and workforce finance | M3 | 34 | 20 | 14 |
| Procurement and spend management | M2 | 30 | 30 | 0 |
| Expense management | M2 | 27 | 19 | 8 |
| Treasury management | M6 | 28 | 23 | 5 |
| Financial planning and analysis | M4 | 35 | 22 | 13 |
| Financial digital twin | M7 | 28 | 1 | 27 |
| AI Virtual CFO | M7 | 35 | 0 | 35 |
| Multi-agent AI finance workforce | M5 | 60 | 49 | 11 |
| Autonomous financial workflows | M5 | 22 | 7 | 15 |
| Enterprise financial management | M6 | 29 | 15 | 14 |
| Inventory, manufacturing and service finance | M6 | 21 | 21 | 0 |
| Project financial management | M6 | 33 | 33 | 0 |
| CRM and finance integration | M6 | 13 | 13 | 0 |
| Financial fraud and risk intelligence | M4 | 19 | 14 | 5 |
| Continuous audit and governance | M6 | 30 | 17 | 13 |
| Document intelligence | M2 | 27 | 22 | 5 |
| Advanced financial reporting | M6 | 41 | 32 | 9 |
| Dashboard design | M1 | 68 | 58 | 10 |
| Executive financial command center | M4 | 38 | 38 | 0 |
| AI financial war room | M7 | 17 | 1 | 16 |
| Revenue leakage and profit optimization | M4 | 15 | 15 | 0 |
| Financial recovery planner | M7 | 11 | 0 | 11 |
| Privacy-preserving financial benchmarking | M7 | 21 | 0 | 21 |
| Internationalization | M8 | 16 | 10 | 6 |
| Integration marketplace | M6 | 50 | 44 | 6 |
| Security and enterprise governance | M1 | 38 | 24 | 14 |
| User experience and onboarding | M1 | 22 | 17 | 5 |
| Accounting data migration | M6 | 20 | 20 | 0 |
| Subscription and monetization engine | M9 | 32 | 32 | 0 |
| Platform super admin | M9 | 22 | 21 | 1 |
| Mobile experience | M8 | 16 | 14 | 2 |
| Performance and scalability | M9 | 21 | 19 | 2 |
| Testing and quality assurance | M1 | 31 | 11 | 20 |
| Demonstration data | M1 | 21 | 19 | 2 |
| Additional differentiating innovations | M7 | 18 | 5 | 13 |
| Navigation structure | M1 | 48 | 34 | 14 |
| Design system | M1 | 36 | 35 | 1 |
| Absolute quality rules | All | 20 | 8 | 12 |

## Features with progress and evidence

### GL-001 — Create a full enterprise-grade accounting foundation

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Foundation in place (ledger, journals, periods, reports). Most GL capabilities below are still to do.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts

### GL-002 — Double-entry bookkeeping

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - packages/accounting-engine/test/journal.test.ts
  - apps/api/test/ledger.e2e.test.ts › journal posting
  - apps/web/src/app/orgs/[orgId]/journals
  - apps/web/e2e/ledger-flow.test.mjs

### GL-003 — Configurable chart of accounts

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › chart of accounts rules
  - POST/PATCH /v1/orgs/:orgId/accounts
  - apps/web/src/app/orgs/[orgId]/accounts
  - apps/web/e2e/ledger-flow.test.mjs

### GL-004 — Hierarchical account structures

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › validates hierarchy, subtype and uniqueness
  - apps/web/src/app/orgs/[orgId]/accounts
  - apps/web/e2e/ledger-flow.test.mjs

### GL-005 — Account types and subtypes

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › validates hierarchy, subtype and uniqueness
  - apps/web/src/app/orgs/[orgId]/accounts
  - apps/web/e2e/ledger-flow.test.mjs

### GL-006 — Journal entries

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › journal posting
  - POST /v1/orgs/:orgId/journals (draft, edit, delete, post)
  - apps/web/src/app/orgs/[orgId]/journals
  - apps/web/e2e/ledger-flow.test.mjs

### GL-008 — Adjusting journals

- Module: General ledger and accounting engine
- Status: **Implemented**
- Notes: Adjusting journals are ordinary posted journals with a memo; there is no separate adjusting-entry type or period-end workflow yet.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts
  - apps/web/src

### GL-009 — Reversing journals

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › reverses a posted entry exactly once and nets it to zero
  - packages/accounting-engine/test/journal.test.ts › builds a reversal that nets the original to zero
  - apps/web/src/app/orgs/[orgId]/journals
  - apps/web/e2e/ledger-flow.test.mjs

### GL-010 — Opening balances

- Module: General ledger and accounting engine
- Status: **Implemented**
- Notes: Opening balances are entered as a journal on the first day; there is no dedicated opening-balance import screen yet.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts
  - apps/web/src

### GL-013 — Accrual accounting

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: The ledger records accruals (AR/AP based entries). Accrual vs cash reporting basis switch is not done.
- Evidence:
  - packages/accounting-engine/test/reports.test.ts

### GL-015 — Multi-period accounting

- Module: General ledger and accounting engine
- Status: **Implemented**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › creates further fiscal years
  - packages/accounting-engine/test/periods.test.ts
  - apps/web/src

### GL-016 — Financial periods

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - packages/accounting-engine/test/periods.test.ts
  - apps/api/test/ledger.e2e.test.ts › period locks
  - apps/web/src/app/orgs/[orgId]/periods
  - apps/web/e2e/ledger-flow.test.mjs

### GL-017 — Fiscal calendars

- Module: General ledger and accounting engine
- Status: **Implemented**
- Evidence:
  - packages/accounting-engine/test/periods.test.ts › generates an April-March fiscal year
  - apps/web/src

### GL-018 — Period locks

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › blocks posting into a locked period and allows it again after unlock
  - packages/database/prisma/migrations/*_init/migration.sql (integrity triggers)
  - apps/web/src/app/orgs/[orgId]/periods
  - apps/web/e2e/ledger-flow.test.mjs

### GL-019 — Posting controls

- Module: General ledger and accounting engine
- Status: **Implemented**
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › roles and permissions
  - apps/api/test/ledger.e2e.test.ts › journal posting
  - apps/web/src

### GL-020 — Audit history

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › audit trail
  - apps/web/src/app/orgs/[orgId]/audit
  - apps/web/e2e/ledger-flow.test.mjs

### GL-021 — Trial balance

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › financial reports
  - packages/accounting-engine/test/reports.test.ts
  - apps/web/src/app/orgs/[orgId]/reports/trial-balance
  - apps/web/e2e/ledger-flow.test.mjs

### GL-022 — General ledger reports

- Module: General ledger and accounting engine
- Status: **Implemented**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › builds an account ledger with opening and running balances
  - apps/web/src

### GL-024 — Cost centers

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Departments serve as cost centres: expenses tagged to a department are its costs and the report shows them per department. Not built: a separate cost centre hierarchy, cost allocation rules, cost centre budgets.
- Evidence:
  - packages/accounting-engine/src/dimensions.ts
  - packages/accounting-engine/test/dimensions.test.ts
  - apps/api/src/dimensions/dimensions.service.ts
  - apps/api/src/dimensions/check.ts
  - apps/api/test/dimensions.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/dimensions/page.tsx
  - apps/web/src/components/dimensions/line-dimensions.tsx
  - apps/web/e2e/dimensions-flow.test.mjs
  - packages/database/prisma/migrations/20261103070000_financial_dimensions/migration.sql
  - docs/FINANCIAL_DIMENSIONS.md

### GL-026 — Departments

- Module: General ledger and accounting engine
- Status: **Tested**
- Notes: Departments: code, name, description, active; tag any journal or document line; profit and loss by department.
- Evidence:
  - packages/accounting-engine/src/dimensions.ts
  - packages/accounting-engine/test/dimensions.test.ts
  - apps/api/src/dimensions/dimensions.service.ts
  - apps/api/src/dimensions/check.ts
  - apps/api/test/dimensions.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/dimensions/page.tsx
  - apps/web/src/components/dimensions/line-dimensions.tsx
  - apps/web/e2e/dimensions-flow.test.mjs
  - packages/database/prisma/migrations/20261103070000_financial_dimensions/migration.sql
  - docs/FINANCIAL_DIMENSIONS.md

### GL-029 — Projects

- Module: General ledger and accounting engine
- Status: **Tested**
- Notes: Projects: code, name, customer, start and end dates, active; tag any journal or document line; profit and loss by project. Not built: project budgets, time or billing by project.
- Evidence:
  - packages/accounting-engine/src/dimensions.ts
  - packages/accounting-engine/test/dimensions.test.ts
  - apps/api/src/dimensions/dimensions.service.ts
  - apps/api/src/dimensions/check.ts
  - apps/api/test/dimensions.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/dimensions/page.tsx
  - apps/web/src/components/dimensions/line-dimensions.tsx
  - apps/web/e2e/dimensions-flow.test.mjs
  - packages/database/prisma/migrations/20261103070000_financial_dimensions/migration.sql
  - docs/FINANCIAL_DIMENSIONS.md

### GL-030 — Financial dimensions

- Module: General ledger and accounting engine
- Status: **Tested**
- Notes: Departments and projects as masters (code unique per kind, never deleted, made inactive instead) tagging journal, invoice, credit note, bill and vendor credit lines; tags checked by organisation, kind and active state in the API and by the database, carried from document lines to the journal and kept on reversals. The older free-form JSON dimensions on journal lines remain but are not reported. Not built: location or custom dimensions, required tags per account.
- Evidence:
  - packages/accounting-engine/src/dimensions.ts
  - packages/accounting-engine/test/dimensions.test.ts
  - apps/api/src/dimensions/dimensions.service.ts
  - apps/api/src/dimensions/check.ts
  - apps/api/test/dimensions.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/dimensions/page.tsx
  - apps/web/src/components/dimensions/line-dimensions.tsx
  - apps/web/e2e/dimensions-flow.test.mjs
  - packages/database/prisma/migrations/20261103070000_financial_dimensions/migration.sql
  - docs/FINANCIAL_DIMENSIONS.md

### GL-032 — Account reconciliation

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Bank and cash accounts can be reconciled. Other balance-sheet account reconciliations are not built.
- Evidence:
  - apps/api/test/banking.e2e.test.ts

### GL-037 — Every posted journal must balance

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - packages/accounting-engine/test/journal.test.ts › rejects an unbalanced entry
  - apps/api/test/ledger.e2e.test.ts › refuses an unbalanced posted entry even if inserted directly in SQL
  - packages/database/prisma/migrations/*_init/migration.sql (integrity triggers) (deferred constraint trigger)

### GL-038 — Use fixed-precision decimal arithmetic

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - packages/accounting-engine/test/money.test.ts
  - decimal.js with 40-digit precision; NUMERIC(24,6) columns

### GL-039 — Never use binary floating-point arithmetic for monetary calculations

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - packages/accounting-engine/test/money.test.ts › refuses JS numbers
  - apps/api/test/ledger.e2e.test.ts › JSON numbers are refused

### GL-040 — Store transaction currency, functional currency and applicable exchange rates

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › converts foreign-currency lines to the functional currency
  - packages/accounting-engine/test/journal.test.ts › converts foreign-currency lines

### GL-041 — Prevent unauthorized changes to posted entries

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › blocks any direct change to posted entries at the database level
  - apps/api/test/auth-tenancy.e2e.test.ts › roles and permissions

### GL-042 — Corrections must use auditable reversal or adjustment entries

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › reverses a posted entry exactly once

### GL-043 — Implement idempotent posting and transaction-level concurrency controls

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › idempotency and concurrency (retries, concurrent retries, 25 concurrent posts)

### GL-044 — Maintain immutable financial posting history

- Module: General ledger and accounting engine
- Status: **Tested**
- Evidence:
  - packages/database/prisma/migrations/*_init/migration.sql (integrity triggers)
  - apps/api/test/ledger.e2e.test.ts › immutability and reversal

### AR-001 — Build a comprehensive AR module

- Module: Accounts receivable
- Status: **Implementing**
- Notes: Slice 1 of AR: customers, invoices, credit notes, receipts, allocation, statements, ageing. Quotes, orders, recurring billing, reminders, write-offs and the AI items are not started.
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts
  - apps/web/e2e/sales-flow.test.mjs

### AR-002 — Customer management

- Module: Accounts receivable
- Status: **Tested**
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › roles and tenants
  - apps/web/e2e/sales-flow.test.mjs
  - /v1/orgs/:orgId/contacts
  - apps/web/src/app/orgs/[orgId]/sales/customers

### AR-004 — Customer credit limits

- Module: Accounts receivable
- Status: **Tested**
- Notes: Override is audited.
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › credit limits
  - apps/web/src/components/ledger/document-form.tsx

### AR-009 — Tax invoices

- Module: Accounts receivable
- Status: **Tested**
- Notes: Invoices with tenant-configured tax rates. Not a statutory e-invoice format; no PDF or emailing yet. Printed with invoice templates (country presets, themes, HTML) and e-signed with a SHA-256 of the signed content.
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › invoices
  - packages/accounting-engine/test/documents.test.ts
  - apps/web/e2e/sales-flow.test.mjs
  - apps/api/src/invoice-templates/invoice-templates.service.ts
  - apps/web/e2e/invoice-templates-flow.test.mjs

### AR-016 — Credit notes

- Module: Accounts receivable
- Status: **Tested**
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › applies a credit note and settles the invoice
  - packages/accounting-engine/test/documents.test.ts

### AR-019 — Payment allocation

- Module: Accounts receivable
- Status: **Tested**
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › receipts, credits and ageing
  - apps/web/e2e/sales-flow.test.mjs

### AR-020 — Partial payments

- Module: Accounts receivable
- Status: **Tested**
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › records a partial receipt against an invoice
  - apps/web/e2e/sales-flow.test.mjs

### AR-021 — Advance payments

- Module: Accounts receivable
- Status: **Tested**
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › keeps an unallocated receipt as a customer credit

### AR-022 — Customer statements

- Module: Accounts receivable
- Status: **Tested**
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › produces a customer statement
  - apps/web/src/components/ledger/contact-detail.tsx

### AR-023 — Receivable aging

- Module: Accounts receivable
- Status: **Tested**
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › ageing ties to the receivables control account
  - apps/web/e2e/sales-flow.test.mjs

### AR-024 — Collection reminders

- Module: Accounts receivable
- Status: **Integration pending**
- Notes: Collection reminders as an automation: "An invoice is overdue" (N days after the due date, still not fully paid) can email the customer and give a task, once per invoice. Waiting on a real SMTP server for a live check. Also AI-drafted reminders with human approval on the Collections page (AR-035). No reminder sequences, escalation by age or tracking of replies yet.
- Evidence:
  - apps/api/test/workflow-schedules.e2e.test.ts
  - apps/web/e2e/automations-schedule-email.test.mjs
  - docs/WORKFLOW_AUTOMATIONS.md
  - apps/api/test/collections.e2e.test.ts
  - apps/web/e2e/collections-flow.test.mjs

### AR-032 — Revenue leakage detection

- Module: Accounts receivable
- Status: **Tested**
- Notes: Regular customer not billed: a customer invoiced in each of the previous N months (default 3) with no invoice in the last complete month. Rule-based; no contract or subscription data yet.
- Evidence:
  - packages/accounting-engine/src/alerts.ts
  - packages/accounting-engine/test/alerts.test.ts
  - apps/api/src/alerts
  - apps/api/test/alerts.e2e.test.ts
  - apps/web/e2e/alerts-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/alerts

### AR-035 — Automated reminder drafting

- Module: Accounts receivable
- Status: **Integration pending**
- Notes: The AI model (Anthropic Claude through the copilot model) drafts one plain-text reminder per customer with overdue invoices, from facts worked out from posted invoices, allocations, receipts and earlier reminders. Every amount and invoice number in a draft (or an edit) is checked against those facts, and every overdue invoice must be mentioned; a person must approve and send each one, after the balances are checked again. Tested with a scripted model and a local Messages API stand-in; waiting on ANTHROPIC_API_KEY and a real SMTP server for a live check.
- Evidence:
  - packages/accounting-engine/src/collections.ts
  - packages/accounting-engine/test/collections.test.ts
  - apps/api/src/collections/collections.service.ts
  - apps/api/test/collections.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/sales/collections/page.tsx
  - apps/web/src/app/orgs/[orgId]/sales/collections/[reminderId]/page.tsx
  - apps/web/e2e/collections-flow.test.mjs
  - docs/AI_COLLECTIONS.md

### AP-001 — Supplier management

- Module: Accounts payable
- Status: **Tested**
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › bills and payments
  - apps/web/src/app/orgs/[orgId]/purchases/vendors

### AP-003 — Purchase invoices

- Module: Accounts payable
- Status: **Tested**
- Notes: Same document model as supplier bills.
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › bills and payments
  - apps/web/e2e/sales-flow.test.mjs

### AP-004 — Supplier bills

- Module: Accounts payable
- Status: **Tested**
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › posts a bill to payables with recoverable input tax and pays it
  - apps/web/e2e/sales-flow.test.mjs

### AP-006 — Bill approval workflows

- Module: Accounts payable
- Status: **Tested**
- Notes: Bills (and invoices, credit notes, vendor credits) can require an approval above an amount; enforced by a database trigger.
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts › approvals
  - apps/web/e2e/approvals-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/approvals

### AP-008 — Partial payments

- Module: Accounts payable
- Status: **Implemented**
- Notes: Shares the receipts code path, which is tested for partial allocation; no purchases-specific partial test yet.
- Evidence:
  - apps/api/src/ledgers/documents.service.ts
  - packages/accounting-engine/test/documents.test.ts

### AP-009 — Advance payments

- Module: Accounts payable
- Status: **Implemented**
- Notes: Unallocated vendor payment stays as a vendor credit; shares the tested receipts code path.
- Evidence:
  - apps/api/src/ledgers/documents.service.ts

### AP-010 — Credit notes

- Module: Accounts payable
- Status: **Implemented**
- Notes: Vendor credits share the tested credit-note path; journal covered by engine tests.
- Evidence:
  - apps/api/src/ledgers/documents.service.ts
  - packages/accounting-engine/test/documents.test.ts

### AP-011 — Supplier statements

- Module: Accounts payable
- Status: **Implemented**
- Evidence:
  - GET /v1/orgs/:orgId/contacts/:id/statement?ledger=PURCHASES
  - apps/web/src/components/ledger/contact-detail.tsx

### AP-012 — Payables aging

- Module: Accounts payable
- Status: **Tested**
- Notes: Same ageing service as receivables; purchases ageing reconciliation is checked by the demo seed.
- Evidence:
  - apps/api/src/ledgers/subledger.service.ts
  - apps/api/test/sales-purchases.e2e.test.ts
  - apps/api/src/seed/seed-demo.ts

### AP-018 — Duplicate invoice detection

- Module: Accounts payable
- Status: **Tested**
- Notes: Per vendor, case-insensitive; enforced by a partial unique index as well as the service.
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › detects a vendor's invoice number entered twice
  - apps/web/e2e/sales-flow.test.mjs

### AP-022 — Payment reconciliation

- Module: Accounts payable
- Status: **Tested**
- Evidence:
  - apps/api/test/banking.e2e.test.ts › records a customer receipt from money in
  - apps/api/test/banking.e2e.test.ts › matching

### BANK-001 — Multiple bank account management

- Module: Banking and reconciliation
- Status: **Tested**
- Notes: Bank and cash accounts are ledger accounts (subtype BANK/CASH).
- Evidence:
  - apps/api/test/banking.e2e.test.ts › lists bank and cash accounts
  - apps/web/src/components/banking/accounts-page.tsx

### BANK-002 — Bank statement import

- Module: Banking and reconciliation
- Status: **Tested**
- Evidence:
  - apps/api/test/banking.e2e.test.ts › statement import
  - packages/accounting-engine/test/bank.test.ts
  - apps/web/e2e/banking-flow.test.mjs

### BANK-003 — CSV, OFX, QIF and applicable banking formats

- Module: Banking and reconciliation
- Status: **Implementing**
- Notes: CSV only (comma, semicolon or tab; five date formats; single or split amount columns). OFX, QIF, MT940 and PDF are not supported yet.
- Evidence:
  - packages/accounting-engine/test/bank.test.ts
  - apps/web/src/components/banking/import-page.tsx

### BANK-005 — Bank reconciliation

- Module: Banking and reconciliation
- Status: **Tested**
- Evidence:
  - apps/api/test/banking.e2e.test.ts › reconciliation
  - apps/web/e2e/banking-flow.test.mjs

### BANK-006 — Transaction matching

- Module: Banking and reconciliation
- Status: **Tested**
- Evidence:
  - apps/api/test/banking.e2e.test.ts › matching
  - packages/accounting-engine/test/bank.test.ts
  - apps/web/e2e/banking-flow.test.mjs

### BANK-008 — Deposit matching

- Module: Banking and reconciliation
- Status: **Tested**
- Evidence:
  - apps/api/test/banking.e2e.test.ts › suggests and auto-matches only unambiguous pairs
  - apps/api/test/banking.e2e.test.ts › records a customer receipt from money in

### BANK-009 — Payment matching

- Module: Banking and reconciliation
- Status: **Tested**
- Notes: Vendor payments from money-out lines share the tested receipt path.
- Evidence:
  - apps/api/test/banking.e2e.test.ts › matches a ledger line to only one statement line
  - apps/api/test/banking.e2e.test.ts › records a customer receipt from money in

### BANK-010 — Bank charges

- Module: Banking and reconciliation
- Status: **Tested**
- Evidence:
  - apps/api/test/banking.e2e.test.ts › books bank charges
  - apps/web/e2e/banking-flow.test.mjs

### BANK-011 — Interest accounting

- Module: Banking and reconciliation
- Status: **Implementing**
- Notes: Interest on loans is worked out per installment and posted to the interest expense account. Not built: interest earned on bank balances or deposits.
- Evidence:
  - packages/accounting-engine/src/loans.ts
  - packages/accounting-engine/test/loans.test.ts
  - apps/api/src/loans/loans.service.ts
  - apps/api/test/loans.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/loans
  - apps/web/e2e/loans-flow.test.mjs
  - packages/database/prisma/migrations/20261103090000_loans_treasury/migration.sql
  - docs/LOANS_AND_TREASURY.md

### BANK-013 — Unreconciled transaction reporting

- Module: Banking and reconciliation
- Status: **Tested**
- Notes: Uncleared ledger items and unmatched statement lines are listed on the reconciliation screen.
- Evidence:
  - apps/api/test/banking.e2e.test.ts › previews the figures and explains why it does not reconcile yet
  - apps/web/src/components/banking/reconcile-page.tsx

### BANK-014 — Bank balance monitoring

- Module: Banking and reconciliation
- Status: **Implementing**
- Notes: Ledger balance, lines to review and last reconciled date per account. No live bank balances, thresholds or alerts.
- Evidence:
  - apps/web/src/components/banking/accounts-page.tsx

### BANK-015 — Reconciliation audit history

- Module: Banking and reconciliation
- Status: **Tested**
- Notes: Reconciliations are never deleted; undo keeps the record and reason; every step is in the audit trail.
- Evidence:
  - apps/api/test/banking.e2e.test.ts › only owners and admins undo a reconciliation, which keeps its record

### BANK-016 — Intelligent transaction classification

- Module: Banking and reconciliation
- Status: **Integration pending**
- Notes: Bank lines are classified by the AI model into a match, a receipt or payment for a contact, or an entry to an account from the chart, using how a person booked the last 15 bank lines as examples. Suggestions only; a person accepts each. Waiting on ANTHROPIC_API_KEY for a live check.
- Evidence:
  - packages/accounting-engine/src/bank-ai.ts
  - packages/accounting-engine/test/bank-ai.test.ts
  - apps/api/src/bank-ai/bank-ai.service.ts
  - apps/api/test/bank-ai.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/banking/[accountId]/ai/page.tsx
  - apps/web/e2e/bank-ai-flow.test.mjs
  - docs/AI_RECONCILIATION.md

### BANK-017 — Adaptive matching suggestions

- Module: Banking and reconciliation
- Status: **Implementing**
- Notes: Rule-based suggestions (amount, date within 14 days, shared words). Nothing learns from past matches yet; no AI.
- Evidence:
  - packages/accounting-engine/src/bank.ts
  - packages/accounting-engine/test/bank.test.ts

### BANK-018 — Duplicate transaction detection

- Module: Banking and reconciliation
- Status: **Tested**
- Notes: Detects lines imported before (fingerprint per account). Does not yet flag duplicate transactions inside the books.
- Evidence:
  - apps/api/test/banking.e2e.test.ts › previews without storing, then imports, and skips lines already imported
  - packages/accounting-engine/test/bank.test.ts
  - apps/web/e2e/banking-flow.test.mjs

### BANK-021 — Missing transaction identification

- Module: Banking and reconciliation
- Status: **Implementing**
- Notes: Reconciliation flags when imported lines do not add up to the statement balance (missing or doubled lines). No line-level detection.
- Evidence:
  - packages/accounting-engine/src/bank.ts › reconciliationIssues
  - apps/api/test/banking.e2e.test.ts

### BANK-024 — Provide a dedicated banking reconciliation workspace

- Module: Banking and reconciliation
- Status: **Tested**
- Evidence:
  - apps/web/src/components/banking
  - apps/web/e2e/banking-flow.test.mjs

### TAX-001 — Create a modular, jurisdiction-aware taxation architecture

- Module: Global taxation engine
- Status: **Implementing**
- Notes: India GST is the first jurisdiction module. Other countries are not started.
- Evidence:
  - packages/tax-engine (pure rules, no framework)
  - TaxRate.kind SIMPLE | GST; TaxSplitter hook in packages/accounting-engine computeDocument

### TAX-002 — Do not hard-code global tax rates

- Module: Global taxation engine
- Status: **Tested**
- Notes: Rates are tenant-configured; no statutory rates are hard-coded.
- Evidence:
  - apps/api/src/tax-rates
  - apps/web/e2e/sales-flow.test.mjs

### TAX-004 — Each country module must include its supported rules, limitations, sources, test cases and maintenance requirements

- Module: Global taxation engine
- Status: **Implementing**
- Notes: India GST documents its rules, limitations, sources, tests and maintenance. No other country module exists yet.
- Evidence:
  - docs/TAX_ENGINE_INDIA_GST.md

### TAX-005 — GST

- Module: Global taxation engine
- Status: **Tested**
- Notes: Registration (GSTIN format + check character), GST rates with categories (taxable, nil-rated, exempt, non-GST), place of supply on every GST document. GSTINs are not verified against the GST portal.
- Evidence:
  - packages/tax-engine/test
  - apps/api/test/gst.e2e.test.ts
  - apps/web/e2e/tax-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/settings/gst

### TAX-006 — CGST

- Module: Global taxation engine
- Status: **Tested**
- Notes: Intra-state supplies: half the rate, rounded on its own, posted to Output/Input CGST.
- Evidence:
  - packages/tax-engine/test/gst.test.ts
  - apps/api/test/gst.e2e.test.ts
  - packages/tax-engine/src/india

### TAX-007 — SGST

- Module: Global taxation engine
- Status: **Tested**
- Notes: Intra-state supplies in states: posted to Output/Input SGST/UTGST.
- Evidence:
  - packages/tax-engine/test/gst.test.ts
  - apps/api/test/gst.e2e.test.ts
  - packages/tax-engine/src/india

### TAX-008 — IGST

- Module: Global taxation engine
- Status: **Tested**
- Notes: Inter-state supplies and exports (with payment of IGST): full rate to Output/Input IGST.
- Evidence:
  - packages/tax-engine/test/gst.test.ts
  - apps/api/test/gst.e2e.test.ts
  - packages/tax-engine/src/india

### TAX-009 — UTGST

- Module: Global taxation engine
- Status: **Tested**
- Notes: Charged instead of SGST in union territories without a legislature (04, 26, 31, 35, 38, 97); shares the SGST/UTGST account.
- Evidence:
  - packages/tax-engine/test/gst.test.ts
  - apps/api/test/gst.e2e.test.ts
  - packages/tax-engine/src/india

### TAX-010 — GST invoicing

- Module: Global taxation engine
- Status: **Tested**
- Notes: Invoices, credit notes, bills and vendor credits carry place of supply, supplier state, buyer/supplier GSTIN and tax by head; posted GST facts are immutable (DB trigger). Bills and vendor credits can be under reverse charge (the vendor is owed the amount without GST; the tax posts as output liability and input credit), including import of services from a vendor outside India (IGST). No PDF tax invoice layout or e-invoice IRN yet.
- Evidence:
  - apps/api/test/gst.e2e.test.ts
  - apps/web/e2e/tax-flow.test.mjs
  - apps/web/src/components/ledger/document-form.tsx
  - apps/web/e2e/withholding-flow.test.mjs

### TAX-011 — HSN/SAC

- Module: Global taxation engine
- Status: **Tested**
- Notes: 4, 6 or 8 digits, required on every GST line except non-GST. No HSN master or rate lookup; units of measure (UQC) are not tracked.
- Evidence:
  - apps/api/test/gst.e2e.test.ts
  - apps/web/e2e/tax-flow.test.mjs

### TAX-012 — Input tax credit

- Module: Global taxation engine
- Status: **Tested**
- Notes: ITC from bills less vendor credits, including reverse-charge tax and import of services (GSTR-3B 4(A)(2), 4(A)(3), 4(A)(5)), set off per CGST Act s.49/49A and rule 88A; reverse-charge tax is paid in cash (s.49(4)). Blocked credits (s.17(5)), reversals, ITC brought forward and GSTR-2B matching are not modelled.
- Evidence:
  - packages/tax-engine/test/returns.test.ts
  - apps/api/test/gst.e2e.test.ts

### TAX-013 — GST reconciliation

- Module: Global taxation engine
- Status: **Tested**
- Notes: GSTR-3B compares document totals with the movement on the six GST ledger accounts. Reconciliation with GSTR-2B is not built.
- Evidence:
  - apps/api/test/gst.e2e.test.ts › flags a manual journal on a GST account as a ledger difference
  - apps/web/src/app/orgs/[orgId]/tax/gst-returns

### TAX-014 — GSTR-related reporting

- Module: Global taxation engine
- Status: **Tested**
- Notes: GSTR-1 (B2B, B2CL, exports, B2CS, CDNR/CDNUR, nil/exempt, HSN B2B/B2C, documents issued) and GSTR-3B (3.1, 3.2, 4, 5, 6.1) working papers. Not the GSTN JSON format; nothing is filed.
- Evidence:
  - packages/tax-engine/test/returns.test.ts
  - apps/api/test/gst.e2e.test.ts
  - apps/web/e2e/tax-flow.test.mjs

### TAX-015 — E-invoicing

- Module: Global taxation engine
- Status: **Tested**
- Notes: India e-invoicing for B2B invoices and credit notes: INV-01 (schema 1.1) JSON for the IRP, single and bulk; import of the IRP response checked against the document (IRN, seller, buyer, number, type, date, total) with optional RS256 signature check against a user-supplied IRP key; signed QR code drawn; 30-day reporting limit for AATO of Rs 10 crore and above; IRN cancellation recorded within 24 hours; a document with a live IRN cannot be voided (API and trigger). No direct IRP/GSP connection, exports, SEZ, debit notes, B2C QR or e-way bills; see docs/E_INVOICING_INDIA.md.
- Evidence:
  - packages/tax-engine/src/india/einvoice.ts
  - packages/tax-engine/test/einvoice.test.ts
  - apps/api/src/e-invoicing
  - apps/api/test/e-invoicing.e2e.test.ts
  - apps/web/e2e/e-invoicing-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/tax/e-invoices
  - apps/web/src/components/e-invoice.tsx

### TAX-016 — E-way bill workflows

- Module: Global taxation engine
- Status: **Tested**
- Notes: India e-way bills for outward supplies on tax invoices: which invoices need one (goods value with GST over Rs 50,000 or a state's own intra-state threshold; services and exempt goods left out; 180-day document limit), the portal's bulk JSON with Part B, validity under Rule 138(10), recording the number, vehicle changes kept in order, cancellation within 24 hours, and no void with a live e-way bill (API and trigger). No portal/GSP connection, exports, inward or job-work movements, extensions or consolidated bills; see docs/E_WAY_BILLS_INDIA.md.
- Evidence:
  - packages/tax-engine/src/india/ewaybill.ts
  - packages/tax-engine/test/ewaybill.test.ts
  - apps/api/src/e-way-bills
  - apps/api/test/e-way-bills.e2e.test.ts
  - apps/web/e2e/e-way-bills-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/tax/e-way-bills
  - apps/web/src/components/e-way-bill.tsx

### TAX-017 — TDS

- Module: Global taxation engine
- Status: **Tested**
- Notes: Income-tax Act 2025 s.393(1) templates (contractors, technical and professional fees, commission, rent, purchase of goods) or tenant-defined sections; single-document and aggregate thresholds per tax year or month, whole-amount catch-up or excess-only; PAN-based rates (individual/HUF, no-PAN). TDS on bills is worked out on the amount before GST, previewed in the form, posted to TDS payable and cuts what the vendor is owed. Register by quarter, challans (Dr TDS payable, Cr bank, optional interest) with void, and a ledger check. No lower-deduction certificates, no TDS on vendor credits or advances, no Form 26Q/140 file and nothing is filed.
- Evidence:
  - packages/tax-engine/src/india/withholding.ts
  - packages/tax-engine/test/withholding.test.ts
  - apps/api/test/withholding.e2e.test.ts
  - apps/web/e2e/withholding-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/tax/tds-tcs
  - apps/web/src/app/orgs/[orgId]/settings/tds-tcs

### TAX-018 — TCS

- Module: Global taxation engine
- Status: **Tested**
- Notes: Tenant-defined TCS sections on invoices, worked out on the invoice value including GST and added to what the customer pays (TCS payable). Same register, challans and ledger check as TDS. No built-in TCS templates, no TCS on receipts, no Form 27EQ file.
- Evidence:
  - packages/tax-engine/test/withholding.test.ts
  - apps/api/test/withholding.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/tax/tds-tcs

### TAX-021 — Advance tax calculations

- Module: Global taxation engine
- Status: **Implementing**
- Notes: Advance tax instalment dates (15/45/75/100%) are tracked and can be marked paid with the challan. The tax itself is not calculated.
- Evidence:
  - packages/tax-engine/src/india/calendar.ts
  - apps/api/test/compliance.e2e.test.ts

### TAX-022 — Tax payment tracking

- Module: Global taxation engine
- Status: **Implementing**
- Notes: TDS and TCS challans are recorded with due dates (7th of the next month, 30 April for March) and overdue amounts. GST cash payments (PMT-06) and advance tax are not tracked yet. The compliance calendar shows each monthly TDS/TCS, PF, ESI and PT payment as done when its challan or payroll payment is recorded; advance tax and GST payments are marked paid/filed by hand.
- Evidence:
  - apps/api/src/withholding/withholding.service.ts
  - apps/api/test/compliance.e2e.test.ts
  - apps/api/test/withholding.e2e.test.ts
  - apps/web/e2e/withholding-flow.test.mjs

### TAX-023 — Statutory deadline calendars

- Module: Global taxation engine
- Status: **Tested**
- Notes: India compliance calendar: GST (monthly or QRMP, GSTR-9), TDS/TCS deposits and quarterly statements (Forms 138/140/143), PF, ESI, Maharashtra PT and advance tax, from the organisation set-up. Payments are settled by records in the books; returns are marked filed with the acknowledgement (void-only records). No holiday shifts or notified extensions; see docs/COMPLIANCE_CALENDAR_INDIA.md.
- Evidence:
  - packages/tax-engine/src/india/calendar.ts
  - packages/tax-engine/test/calendar.test.ts
  - apps/api/test/compliance.e2e.test.ts
  - apps/web/e2e/compliance-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/tax/compliance

### TAX-027 — External government submission must be implemented only through approved and authorized integrations

- Module: Global taxation engine
- Status: **Implementing**
- Notes: Followed by design: Talk2Tax submits nothing to a government system. E-invoice JSON is uploaded by the user to the IRP and the IRP's response is imported; GST returns and TDS statements are marked filed by hand. An approved GSP/ASP integration is not built.
- Evidence:
  - docs/E_INVOICING_INDIA.md
  - docs/COMPLIANCE_CALENDAR_INDIA.md
  - apps/api/src/e-invoicing/e-invoicing.service.ts

### TAX-037 — Withholding taxes

- Module: Global taxation engine
- Status: **Implementing**
- Notes: The engine supports one withholding (deduct or collect) per document with its own payable account; India TDS/TCS is the only jurisdiction configured.
- Evidence:
  - packages/tax-engine/src/india/withholding.ts
  - packages/accounting-engine/src/documents.ts

### TAX-053 — Tax calculations must be performed by deterministic, tested rules

- Module: Global taxation engine
- Status: **Tested**
- Notes: Decimal-only arithmetic; the web form runs the same engine as the API.
- Evidence:
  - packages/tax-engine/test
  - packages/accounting-engine/test

### PAY-001 — Build a complete payroll financial management domain

- Module: Payroll and workforce finance
- Status: **Implementing**
- Notes: India payroll slice: employees, salary structures, monthly pay runs, payslips, ledger posting and statutory payments. Approvals, cost allocation, reporting and other countries are not built.
- Evidence:
  - apps/api/test/payroll.e2e.test.ts
  - apps/web/e2e/payroll-flow.test.mjs

### PAY-002 — Employee master records

- Module: Payroll and workforce finance
- Status: **Tested**
- Notes: Code, PAN (validated), UAN/ESI numbers, joining and leaving dates, work state, PT category, PF/EPS membership and previous-employer salary for the tax year. Identity fields freeze once a payslip is posted.
- Evidence:
  - apps/api/test/payroll.e2e.test.ts
  - apps/web/e2e/payroll-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/payroll/employees

### PAY-003 — Salary structures

- Module: Payroll and workforce finance
- Status: **Tested**
- Notes: Dated monthly structures (from the 1st of a month) with components marked as wages or excluded allowances under the Code on Social Security 2020; revisions are kept as history and a used structure cannot change.
- Evidence:
  - apps/api/test/payroll.e2e.test.ts
  - apps/web/e2e/payroll-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/payroll/employees/[employeeId]

### PAY-004 — Payroll calendars

- Module: Payroll and workforce finance
- Status: **Implementing**
- Notes: Payroll statutory due dates (PF, ESI, PT, TDS on salary, Form 138) are on the compliance calendar. No pay calendars or pay frequencies other than monthly.
- Evidence:
  - apps/api/test/compliance.e2e.test.ts

### PAY-005 — Earnings

- Module: Payroll and workforce finance
- Status: **Tested**
- Notes: Components pro-rated by paid days; the 50% excluded-allowance add-back decides PF and ESI wages.
- Evidence:
  - packages/tax-engine/test/payroll.test.ts
  - apps/api/test/payroll.e2e.test.ts
  - apps/web/e2e/payroll-flow.test.mjs

### PAY-006 — Deductions

- Module: Payroll and workforce finance
- Status: **Tested**
- Notes: Employee PF, ESI, Maharashtra professional tax and TDS on salary (new regime). No voluntary deductions, loans or advances.
- Evidence:
  - packages/tax-engine/test/payroll.test.ts
  - apps/api/test/payroll.e2e.test.ts
  - apps/web/e2e/payroll-flow.test.mjs

### PAY-007 — Bonuses

- Module: Payroll and workforce finance
- Status: **Implementing**
- Notes: Bonuses can be added as one-off earnings on a payslip and are taxed in the month. No statutory bonus (Payment of Bonus Act) calculation.
- Evidence:
  - apps/api/test/payroll.e2e.test.ts
  - apps/web/e2e/payroll-flow.test.mjs

### PAY-009 — Reimbursements

- Module: Payroll and workforce finance
- Status: **Implementing**
- Notes: Expense reimbursements only; no payroll.
- Evidence:
  - apps/api/test/expenses.e2e.test.ts

### PAY-011 — Leave-related adjustments

- Module: Payroll and workforce finance
- Status: **Implementing**
- Notes: Loss-of-pay days (whole or half) per payslip, and pro-rating for joining or leaving mid-month. No leave balances or leave module.
- Evidence:
  - packages/tax-engine/test/payroll.test.ts
  - apps/api/test/payroll.e2e.test.ts
  - apps/web/e2e/payroll-flow.test.mjs

### PAY-016 — Payroll journals

- Module: Payroll and workforce finance
- Status: **Tested**
- Notes: Posting a pay run journals gross salary and employer PF/ESI against net pay, PF, ESI, PT and TDS payables; voiding reverses it. Source PAYROLL.
- Evidence:
  - apps/api/test/payroll.e2e.test.ts
  - apps/web/e2e/payroll-flow.test.mjs

### PAY-017 — Salary payment preparation

- Module: Payroll and workforce finance
- Status: **Implementing**
- Notes: Records net-pay and statutory payments from a bank account with due dates (Dr liability, Cr bank). No bank transfer files, ECR or challan files.
- Evidence:
  - apps/api/test/payroll.e2e.test.ts
  - apps/web/e2e/payroll-flow.test.mjs

### PAY-018 — Payslips

- Module: Payroll and workforce finance
- Status: **Tested**
- Notes: Printable payslip with earnings, deductions, employer contributions, income-tax working and year-to-date figures. No PDF or email delivery.
- Evidence:
  - apps/api/test/payroll.e2e.test.ts
  - apps/web/e2e/payroll-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/payroll/runs/[runId]/payslips/[employeeId]

### PAY-025 — For India, design configurable statutory components covering applicable PF, ESI, professional tax, TDS and other payroll obligations

- Module: Payroll and workforce finance
- Status: **Implementing**
- Notes: PF/EPS/EDLI (with the Rs 25,000 ceiling from 17 Sep 2026), ESI, Maharashtra PT and new-regime TDS on salary. Not built: old regime, other states' PT, LWF, gratuity, perquisites. See docs/PAYROLL_INDIA.md.
- Evidence:
  - packages/tax-engine/test/payroll.test.ts
  - apps/api/test/payroll.e2e.test.ts

### PAY-026 — Country-specific payroll calculations must be activated only after appropriate regulatory validation

- Module: Payroll and workforce finance
- Status: **Implementing**
- Notes: Every rate is cited to its source in the engine and on the settings page, but the rules have not been reviewed by a payroll professional; that review is required before real use.
- Evidence:
  - docs/PAYROLL_INDIA.md

### EXP-002 — Employee expense submissions

- Module: Expense management
- Status: **Tested**
- Notes: Employees (new EMPLOYEE role) and other staff create, edit, submit and withdraw their own claims; tax-inclusive amounts with tax split out.
- Evidence:
  - apps/api/test/expenses.e2e.test.ts
  - apps/web/e2e/expenses-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/expenses

### EXP-003 — Mobile receipt capture

- Module: Expense management
- Status: **Implementing**
- Notes: Receipts (photo or PDF) upload from the browser, including on a phone; there is no native mobile app or camera capture flow.
- Evidence:
  - apps/web/e2e/expenses-flow.test.mjs

### EXP-005 — Expense categories

- Module: Expense management
- Status: **Implemented**
- Notes: Categories are the organisation's active expense accounts; no separate category list or per-category limits.
- Evidence:
  - apps/api/src/expenses/expenses.service.ts › options

### EXP-009 — Reimbursements

- Module: Expense management
- Status: **Tested**
- Notes: One claim at a time, recorded from a bank or cash account (Dr employee reimbursements payable / Cr bank). No batch payouts or bank file generation.
- Evidence:
  - apps/api/test/expenses.e2e.test.ts › is reimbursed from a bank account, which clears what is owed
  - apps/web/e2e/expenses-flow.test.mjs

### EXP-010 — Expense approval workflows

- Module: Expense management
- Status: **Tested**
- Notes: Single-step approval by anyone with approvals.decide other than the claimant (service and database trigger); approval posts the expense.
- Evidence:
  - apps/api/test/expenses.e2e.test.ts
  - apps/web/e2e/expenses-flow.test.mjs

### EXP-017 — Expense reporting

- Module: Expense management
- Status: **Implementing**
- Notes: Totals by status for a person or the organisation; no expense reports by category or period yet beyond the general ledger.
- Evidence:
  - GET /v1/orgs/:orgId/expense-claims (summary by status)

### EXP-018 — Duplicate expense detection

- Module: Expense management
- Status: **Implemented**
- Notes: Warns when another live claim by the same person has a line with the same date and amount. Does not block; no receipt-image comparison.
- Evidence:
  - packages/accounting-engine/test/expenses.test.ts
  - apps/api/test/expenses.e2e.test.ts › flags a receipt that looks claimed twice

### EXP-021 — Missing receipt detection

- Module: Expense management
- Status: **Implemented**
- Notes: Shows when a claim has no receipts, at submission and approval. Receipts are not required by a policy.
- Evidence:
  - apps/web/src/components/expenses/claim-detail.tsx

### TRS-002 — Cash positioning

- Module: Treasury management
- Status: **Implementing**
- Notes: Cash and bank balances from posted journals up to today, and net cash after borrowings, on the treasury overview. Not built: intraday or bank-fed balances, balances by entity or currency.
- Evidence:
  - apps/api/src/loans/loans.service.ts
  - apps/api/test/loans.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/treasury/page.tsx
  - apps/web/e2e/loans-flow.test.mjs
  - docs/LOANS_AND_TREASURY.md

### TRS-009 — Debt management

- Module: Treasury management
- Status: **Tested**
- Notes: Loans kept as a register: money received posted or brought in from opening balances, installments posted from the bank split into principal and interest, prepayments with charges (shorter term or lower installment), floating-rate changes, reversal of the latest entry, closing when repaid, overdue installments, and what is owed within 12 months and later. Not built: covenants, security, drawdowns in tranches, moratorium periods, foreign-currency loans, loans given (receivable).
- Evidence:
  - packages/accounting-engine/src/loans.ts
  - packages/accounting-engine/test/loans.test.ts
  - apps/api/src/loans/loans.service.ts
  - apps/api/test/loans.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/loans
  - apps/web/e2e/loans-flow.test.mjs
  - packages/database/prisma/migrations/20261103090000_loans_treasury/migration.sql
  - docs/LOANS_AND_TREASURY.md

### TRS-010 — Loan schedules

- Module: Treasury management
- Status: **Tested**
- Notes: Repayment schedules for EMI and equal-principal loans, previewed as the loan is entered, recomputed after prepayments and rate changes, with installments paid and still to pay. Not built: bullet or balloon repayments, quarterly or irregular installments, step-up EMIs.
- Evidence:
  - packages/accounting-engine/src/loans.ts
  - packages/accounting-engine/test/loans.test.ts
  - apps/api/src/loans/loans.service.ts
  - apps/api/test/loans.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/loans
  - apps/web/e2e/loans-flow.test.mjs
  - packages/database/prisma/migrations/20261103090000_loans_treasury/migration.sql
  - docs/LOANS_AND_TREASURY.md

### TRS-011 — Interest calculations

- Module: Treasury management
- Status: **Tested**
- Notes: Interest monthly on the opening balance of each installment period (monthly rests), rounded to the currency; the lender's own split can be recorded instead. Not built: daily-balance interest, interest accrued at month end between installment dates, interest income on deposits.
- Evidence:
  - packages/accounting-engine/src/loans.ts
  - packages/accounting-engine/test/loans.test.ts
  - apps/api/src/loans/loans.service.ts
  - apps/api/test/loans.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/loans
  - apps/web/e2e/loans-flow.test.mjs
  - packages/database/prisma/migrations/20261103090000_loans_treasury/migration.sql
  - docs/LOANS_AND_TREASURY.md

### TRS-016 — Treasury dashboards

- Module: Treasury management
- Status: **Tested**
- Notes: Treasury overview: cash and bank balances, borrowings (within 12 months and later), net cash or debt, installments due in 30 days and overdue, repayments by month for 12 months, interest paid this financial year, and a check of each loan account in the ledger against the loans. Not built: cash forecast on the same page (see the cash-flow forecast), investments, FX exposure, multi-entity cash pooling.
- Evidence:
  - apps/api/src/loans/loans.service.ts
  - apps/api/test/loans.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/treasury/page.tsx
  - apps/web/e2e/loans-flow.test.mjs
  - docs/LOANS_AND_TREASURY.md

### FPA-002 — Annual budgets

- Module: Financial planning and analysis
- Status: **Tested**
- Notes: Annual budgets per fiscal year for revenue and expense accounts, as numbered versions (empty, copied, or last year's actuals with a percentage change), with an annual amount spread evenly over the months to the paisa. See docs/BUDGETS.md.
- Evidence:
  - packages/accounting-engine/src/budgets.ts
  - packages/accounting-engine/test/budgets.test.ts
  - apps/api/src/budgets
  - apps/api/test/budgets.e2e.test.ts
  - apps/web/e2e/budgets-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/planning/budgets

### FPA-004 — Monthly budgets

- Module: Financial planning and analysis
- Status: **Tested**
- Notes: Twelve monthly amounts per account, entered in a grid or spread from an annual amount; quarters are a reporting view only (no entry by quarter). See docs/BUDGETS.md.
- Evidence:
  - packages/accounting-engine/src/budgets.ts
  - packages/accounting-engine/test/budgets.test.ts
  - apps/api/src/budgets
  - apps/api/test/budgets.e2e.test.ts
  - apps/web/e2e/budgets-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/planning/budgets/[budgetId]

### FPA-008 — Cash-flow forecasting

- Module: Financial planning and analysis
- Status: **Tested**
- Notes: Daily cash and bank forecast from open invoices and bills at each contact's usual payment delay (last year's settled documents; everyone's history or the due date when fewer than 3), planned receipts and payments (once, weekly, monthly, quarterly, yearly), a low and high case, a minimum-balance warning, and weekly or monthly buckets. Rule-based, no machine learning. See docs/CASH_FLOW_FORECAST.md.
- Evidence:
  - packages/accounting-engine/src/cashflow.ts
  - packages/accounting-engine/test/cashflow.test.ts
  - apps/api/src/cash-flow
  - apps/api/test/cash-flow.e2e.test.ts
  - apps/web/e2e/cash-flow-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/planning/cash-flow

### FPA-014 — Variance analysis

- Module: Financial planning and analysis
- Status: **Tested**
- Notes: Budget vs actual by month, quarter or year against posted journals: variance, percentage and favourable/unfavourable per account and for revenue, expenses and net income, year to date, periods in progress, unbudgeted accounts flagged. No drill-down or export yet.
- Evidence:
  - packages/accounting-engine/src/budgets.ts
  - packages/accounting-engine/test/budgets.test.ts
  - apps/api/src/budgets
  - apps/api/test/budgets.e2e.test.ts
  - apps/web/e2e/budgets-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/planning/budget-vs-actual

### FPA-021 — Financial KPI management

- Module: Financial planning and analysis
- Status: **Tested**
- Notes: 13 KPIs computed monthly from posted journals (revenue, gross/operating/net margin, opex ratio, current and quick ratio, working capital, liabilities to equity, DSO, DPO, net cash flow, runway), each with its formula, components, previous month, same month last year, 13-month history, and a target (at least / at most) that is met or missed. Fixed catalogue: no custom KPI formulas. See docs/KPIS_AND_MANAGEMENT_REPORTS.md.
- Evidence:
  - packages/accounting-engine/src/kpis.ts
  - packages/accounting-engine/test/kpis.test.ts
  - apps/api/src/kpis
  - apps/api/test/kpis.e2e.test.ts
  - apps/web/e2e/kpis-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/reports/kpis

### FPA-023 — Budget approvals

- Module: Financial planning and analysis
- Status: **Tested**
- Notes: Submit, withdraw, send back with a reason, approve by someone other than the submitter (API and CHECK); one approved version per year, earlier one superseded; approved versions immutable (triggers). Single approval step.
- Evidence:
  - packages/accounting-engine/src/budgets.ts
  - packages/accounting-engine/test/budgets.test.ts
  - apps/api/src/budgets
  - apps/api/test/budgets.e2e.test.ts
  - apps/web/e2e/budgets-flow.test.mjs
  - packages/database/prisma/migrations/20261101260000_budgets

### FPA-024 — Forecast accuracy monitoring

- Module: Financial planning and analysis
- Status: **Tested**
- Notes: Saved forecasts are immutable (trigger) and compared day by day with the actual closing cash from posted journals: average miss, bias, share of days inside the range, largest miss. No alerts when accuracy drops.
- Evidence:
  - packages/accounting-engine/src/cashflow.ts
  - packages/accounting-engine/test/cashflow.test.ts
  - apps/api/src/cash-flow
  - apps/api/test/cash-flow.e2e.test.ts
  - apps/web/e2e/cash-flow-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/planning/cash-flow
  - packages/database/prisma/migrations/20261101280000_cash_flow_forecast

### FPA-029 — 30-day forecasts

- Module: Financial planning and analysis
- Status: **Tested**
- Notes: 30-day horizon of the cash-flow forecast (weekly buckets). Cash only: not a profit or balance sheet forecast.
- Evidence:
  - packages/accounting-engine/src/cashflow.ts
  - packages/accounting-engine/test/cashflow.test.ts
  - apps/api/src/cash-flow
  - apps/api/test/cash-flow.e2e.test.ts
  - apps/web/e2e/cash-flow-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/planning/cash-flow

### FPA-030 — 60-day forecasts

- Module: Financial planning and analysis
- Status: **Tested**
- Notes: 60-day horizon of the cash-flow forecast (weekly buckets). Cash only: not a profit or balance sheet forecast.
- Evidence:
  - packages/accounting-engine/src/cashflow.ts
  - packages/accounting-engine/test/cashflow.test.ts
  - apps/api/src/cash-flow
  - apps/api/test/cash-flow.e2e.test.ts
  - apps/web/e2e/cash-flow-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/planning/cash-flow

### FPA-031 — 90-day forecasts

- Module: Financial planning and analysis
- Status: **Tested**
- Notes: 90-day horizon of the cash-flow forecast (weekly buckets). Cash only: not a profit or balance sheet forecast.
- Evidence:
  - packages/accounting-engine/src/cashflow.ts
  - packages/accounting-engine/test/cashflow.test.ts
  - apps/api/src/cash-flow
  - apps/api/test/cash-flow.e2e.test.ts
  - apps/web/e2e/cash-flow-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/planning/cash-flow

### FPA-032 — 180-day forecasts

- Module: Financial planning and analysis
- Status: **Tested**
- Notes: 180-day horizon of the cash-flow forecast (monthly buckets). Cash only: not a profit or balance sheet forecast.
- Evidence:
  - packages/accounting-engine/src/cashflow.ts
  - packages/accounting-engine/test/cashflow.test.ts
  - apps/api/src/cash-flow
  - apps/api/test/cash-flow.e2e.test.ts
  - apps/web/e2e/cash-flow-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/planning/cash-flow

### FPA-033 — 365-day forecasts

- Module: Financial planning and analysis
- Status: **Tested**
- Notes: 365-day horizon of the cash-flow forecast (monthly buckets). Cash only: not a profit or balance sheet forecast.
- Evidence:
  - packages/accounting-engine/src/cashflow.ts
  - packages/accounting-engine/test/cashflow.test.ts
  - apps/api/src/cash-flow
  - apps/api/test/cash-flow.e2e.test.ts
  - apps/web/e2e/cash-flow-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/planning/cash-flow

### FPA-035 — Provide confidence intervals and model backtesting

- Module: Financial planning and analysis
- Status: **Implemented**
- Notes: Backtesting: a forecast rebuilt from the books as they stood on an earlier day (up to 2 years back), saved and measured against actual cash. The range is the 25th to 75th percentile of payment delays, not a statistical confidence interval; backtests use today's planned items. Kept below Tested until a real interval model exists.
- Evidence:
  - packages/accounting-engine/src/cashflow.ts
  - packages/accounting-engine/test/cashflow.test.ts
  - apps/api/src/cash-flow
  - apps/api/test/cash-flow.e2e.test.ts
  - apps/web/e2e/cash-flow-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/planning/cash-flow

### TWIN-002 — Create a simulation environment representing an organization's financial structure and operating drivers

- Module: Financial digital twin
- Status: **Tested**
- Notes: Monthly driver model built from the last 3, 6 or 12 months of posted figures: revenue as volume x price x exchange rate, cost of sales following volume, payroll, other costs, receivables and payables days, cash, and tax.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-003 — Revenue simulations

- Module: Financial digital twin
- Status: **Tested**
- Notes: Revenue growth per month, from a chosen month.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-004 — Expense simulations

- Module: Financial digital twin
- Status: **Tested**
- Notes: Expense change by percentage and/or monthly amount on operating costs, payroll or cost of sales.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-005 — Hiring scenarios

- Module: Financial digital twin
- Status: **Tested**
- Notes: People, monthly cost each, one-off cost each, from a month.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-006 — Expansion scenarios

- Module: Financial digital twin
- Status: **Tested**
- Notes: One-off cost, running cost, and revenue ramping to full speed.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-007 — Product pricing scenarios

- Module: Financial digital twin
- Status: **Tested**
- Notes: Price change with a volume response; cost of sales follows volume, not price.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-008 — Tax impact scenarios

- Module: Financial digital twin
- Status: **Tested**
- Notes: Income tax rate on profit before tax; losses get no relief (documented simplification). Rate comes from the scenario, else history, else none (asked for).
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-009 — Debt scenarios

- Module: Financial digital twin
- Status: **Tested**
- Notes: New loan repaid by EMI from the month after; interest through profit, principal through cash.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-010 — Investment scenarios

- Module: Financial digital twin
- Status: **Tested**
- Notes: Asset purchase depreciated straight-line from the month after.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-011 — Supplier cost scenarios

- Module: Financial digital twin
- Status: **Tested**
- Notes: Supplier cost change on cost of sales.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-012 — Customer churn scenarios

- Module: Financial digital twin
- Status: **Tested**
- Notes: Monthly compounding churn on volume.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-013 — Currency fluctuations

- Module: Financial digital twin
- Status: **Tested**
- Notes: Share of revenue in foreign currency and a rate change.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-014 — Market downturn scenarios

- Module: Financial digital twin
- Status: **Tested**
- Notes: Revenue drop and slower collections, for a number of months or for good.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-015 — Inflation scenarios

- Module: Financial digital twin
- Status: **Tested**
- Notes: Yearly cost inflation compounded monthly.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-016 — Working capital scenarios

- Module: Financial digital twin
- Status: **Tested**
- Notes: Collection and payment days changes, flowing through receivables and payables.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-017 — Identify missing assumptions

- Module: Financial digital twin
- Status: **Tested**
- Notes: Gaps listed as Inputs to confirm: no tax rate (none in the scenario or history), no revenue in the baseline, no inflation over horizons beyond 12 months, and no investment when hiring five or more people.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-018 — Request necessary inputs

- Module: Financial digital twin
- Status: **Tested**
- Notes: Each missing input is asked as a question, with an Add button for the change it needs.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-019 — Generate scenarios

- Module: Financial digital twin
- Status: **Tested**
- Notes: Nine ready-made templates plus a builder with 15 kinds of change. Templates are fixed placeholder figures, not AI-generated.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-020 — Estimate financial consequences

- Module: Financial digital twin
- Status: **Tested**
- Notes: Monthly projection of revenue, costs, EBITDA, depreciation, interest, tax, net profit, cash flow and closing cash.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-021 — Calculate cash requirements

- Module: Financial digital twin
- Status: **Tested**
- Notes: Lowest cash, the month cash runs out, and cash to raise to stay above the buffer.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-022 — Estimate profitability

- Module: Financial digital twin
- Status: **Tested**
- Notes: Net profit and margin over the horizon, and break-even month.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-023 — Identify key risks

- Module: Financial digital twin
- Status: **Tested**
- Notes: Rule-based risks, each High/Medium/Low: cash runs out (with the amount to raise), cash below the buffer, a loss over the horizon, ending loss-making, thin gross margin, growing receivables, weak loan-payment cover, and a short history.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-024 — Compare alternatives

- Module: Financial digital twin
- Status: **Tested**
- Notes: Up to five saved scenarios side by side with no change, same baseline and horizon.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-025 — Explain assumptions

- Module: Financial digital twin
- Status: **Tested**
- Notes: Every change and baseline figure explained in words in the Assumptions list.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-026 — Save the scenario

- Module: Financial digital twin
- Status: **Tested**
- Notes: Saved per organisation with name, description, baseline and horizon; re-run against the latest actuals on every open; audited.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-027 — Simulations must remain separate from actual accounting records

- Module: Financial digital twin
- Status: **Tested**
- Notes: Scenarios are stored only as inputs in twin_scenarios; nothing posts to the ledger (API and browser tests count journals before and after).
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### TWIN-028 — Provide clear visual differentiation between actual, forecast and hypothetical figures

- Module: Financial digital twin
- Status: **Tested**
- Notes: Actual months solid, hypothetical dashed over a shaded band, every projected figure labelled hypothetical. The separate cash-flow forecast stays on its own page and is not overlaid here.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - packages/database/prisma/migrations/20261103200000_twin_scenarios/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - packages/accounting-engine/test/twin.test.ts
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### VCFO-001 — Build a sophisticated AI Virtual CFO

- Module: AI Virtual CFO
- Status: **Implementing**
- Notes: Virtual CFO built: health score, nine analyses, nine worked questions, board packs and investor updates with a checked AI summary. Peer benchmarking and configurable thresholds are not built.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-002 — Financial health assessment

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Health score out of 100 from five stated rules (liquidity, profitability, working capital, growth, solvency) with a grade.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-003 — Executive financial summaries

- Module: AI Virtual CFO
- Status: **Integration pending**
- Notes: Deterministic headline on every assessment; AI executive summary of packs written from the facts and rejected if it quotes any figure not in them. Tested against the scripted model and the local stand-in; needs a live check with a Claude key.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - apps/web/src/app/orgs/[orgId]/cfo/reports/[reportId]/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-004 — Strategic financial recommendations

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Recommendations from areas needing action, then watch, with priority, link and required approval.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-005 — Liquidity analysis

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Liquidity: cash, current and quick ratios, monthly change in cash, runway, 90-day forecast lowest point against the minimum balance.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-006 — Profitability analysis

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Profitability: revenue, gross, operating and net profit and margins over three months against the previous three and last year.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-007 — Working capital analysis

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Working capital: DSO, DPO, days inventory, cash conversion cycle, overdue receivables.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-008 — Revenue growth analysis

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Revenue growth: three months against the three before and last year, 12 against the 12 before, largest customer share.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-009 — Cost reduction recommendations

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Cost reduction: expense lines up more than 15% on the six months before, with the monthly saving and who approves a cut.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-010 — Financial risk detection

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Risk detection: runway, forecast below minimum, losses, negative equity, interest cover, concentration, overdue filings, high alerts.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-011 — Scenario analysis

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Scenario analysis: 10% salary rise measured on the digital twin; planning section counts saved, approved and waiting scenarios; links to the twin and war room.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-012 — Board reporting

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Board packs: every area, recommendations, commentary, checked AI summary, refresh while draft, finalise (immutable at the database level), print.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - apps/web/src/app/orgs/[orgId]/cfo/reports/[reportId]/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-013 — Investor reporting

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Investor updates: growth, profitability, liquidity, capital and debt, with the same commentary, summary and finalise.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - apps/web/src/app/orgs/[orgId]/cfo/reports/[reportId]/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-014 — Financial planning assistance

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Planning: year-to-date variance against the approved budget and scenario status, with a prompt to prepare a budget.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-015 — Capital allocation analysis

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Capital allocation: free cash above a reserve of three months of fixed costs or the minimum balance, with options and approvals.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-016 — Business expansion analysis

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Expansion: months an expansion adding a fifth to fixed costs could be funded from free cash, with a link to the twin expansion template.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-017 — Debt management analysis

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Debt: loans outstanding, principal and interest due in 12 months, interest cover, debt service cover, liabilities to equity.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-018 — Financial benchmarking

- Module: AI Virtual CFO
- Status: **Implementing**
- Notes: Compares with the organisation's own history (previous months, same months last year) only; peer and industry benchmarks are the benchmarking module.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-019 — Why did profit decrease?

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Why profit changed (fell or rose) last month: accounts by their effect on profit.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-020 — Which clients are most profitable?

- Module: AI Virtual CFO
- Status: **Implementing**
- Notes: Clients ranked by revenue, share, change, overdue and days late. Costs are not recorded per client, so profit per client is not known; the answer says so with low confidence.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-021 — Which projects are losing money?

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Projects with a net loss over 12 months from profit by project.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-022 — How much cash will we need next quarter?

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Cash needed next quarter: minimum balance minus the 90-day forecast lowest point, base and late cases, plus the twin trend.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-023 — What expenses should we investigate?

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Expenses to investigate: accounts more than 25% above their six-month average, plus duplicate and unusual-journal alerts.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-024 — What happens if salaries increase by 10%?

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Salaries +10%: twin with and without, profit, cash and runway.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-025 — Which vendors are charging more than expected?

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Vendors charging more: unit price by vendor and item, last 90 days against the 9 months before, with extra cost.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-026 — What is our current tax exposure?

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Tax exposure: tax payable balances and statutory items overdue or due in 45 days.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-027 — Which invoices are likely to be paid late?

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Invoices likely to be paid late from each customer's record over 12 months.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-028 — Source records

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Every finding and answer lists its source reports and a table of the records behind it.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-029 — Relevant period

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Every finding and answer states its period.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-030 — Calculation method

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Every finding and answer states its calculation method.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-031 — Assumptions

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Every finding and answer lists its assumptions.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-032 — Confidence or uncertainty

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Every finding and answer has a confidence level and the reason.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-033 — Recommended actions

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Every finding and answer lists recommended actions with links.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-034 — Required approvals

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Each recommended action names who has to approve it.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md

### VCFO-035 — Never fabricate financial figures

- Module: AI Virtual CFO
- Status: **Tested**
- Notes: Figures are worked out in code; the AI summary is rejected if it quotes any figure not in the facts; the copilot reads CFO answers through tools and is told to pass on method and confidence.
- Evidence:
  - packages/accounting-engine/src/cfo.ts
  - packages/database/prisma/migrations/20261104180000_virtual_cfo/migration.sql
  - apps/api/src/cfo/cfo.service.ts
  - apps/web/src/app/orgs/[orgId]/cfo/page.tsx
  - packages/accounting-engine/test/cfo.test.ts
  - apps/api/test/cfo.e2e.test.ts
  - apps/web/e2e/cfo-flow.test.mjs
  - docs/VIRTUAL_CFO.md
  - apps/api/src/copilot/copilot.tools.ts

### AGENT-001 — Create a dedicated AI Agent Control Center

- Module: Multi-agent AI finance workforce
- Status: **Tested**
- Notes: AI control center page: every AI agent (copilot, collections, bank reconciliation, month-end close) with its action level, on/off switch, monthly token budget, usage this month, failures, acceptance rate over 90 days, what is running and waiting, and the organisation-wide emergency stop.
- Evidence:
  - apps/api/src/ai-control/ai-control.service.ts
  - apps/api/test/ai-control.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/ai-control/page.tsx
  - apps/web/e2e/ai-control-flow.test.mjs
  - packages/database/prisma/migrations/20261103010000_ai_control_center/migration.sql
  - docs/AI_CONTROL_CENTER.md

### AGENT-004 — Bank Reconciliation Agent

- Module: Multi-agent AI finance workforce
- Status: **Integration pending**
- Notes: Bank reconciliation agent: for each unmatched statement line without an exact one-to-one match (up to 25 per run, oldest first), the AI model (Anthropic Claude) suggests ledger lines already in the books that add up to it, a receipt or payment against open invoices or bills, or an entry to one account, with a confidence and a reason. It sees short references, never ids; every proposal is checked against what it was shown; a person accepts or dismisses each, and accepting goes through the same matching, receipt and entry code as by hand. Tested with a scripted model and a local Messages API stand-in; waiting on ANTHROPIC_API_KEY for a live check.
- Evidence:
  - packages/accounting-engine/src/bank-ai.ts
  - packages/accounting-engine/test/bank-ai.test.ts
  - apps/api/src/bank-ai/bank-ai.service.ts
  - apps/api/test/bank-ai.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/banking/[accountId]/ai/page.tsx
  - apps/web/e2e/bank-ai-flow.test.mjs
  - docs/AI_RECONCILIATION.md

### AGENT-005 — Month-End Closing Agent

- Module: Multi-agent AI finance workforce
- Status: **Integration pending**
- Notes: Month-end closing agent: the AI model (Anthropic Claude) is shown the close checklist and how every account moved in the month against the three months before, points out what looks unusual, and proposes adjusting entries (accruals that reverse next month, prepayment releases, reclasses) using account codes only. Every entry is checked (allowed accounts, balanced, amounts, somewhere open to reverse) and posted only when a person approves it, through the normal journal code. Tested with a scripted model and a local Messages API stand-in; waiting on ANTHROPIC_API_KEY for a live check.
- Evidence:
  - packages/accounting-engine/src/close.ts
  - packages/accounting-engine/test/close.test.ts
  - apps/api/src/close/close.service.ts
  - apps/api/test/close.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/close/[periodId]/page.tsx
  - apps/web/e2e/close-flow.test.mjs
  - docs/MONTH_END_CLOSE.md

### AGENT-024 — Collections Agent

- Module: Multi-agent AI finance workforce
- Status: **Integration pending**
- Notes: Collections agent: drafting runs (up to 20 customers, most overdue first; customers with no email, a reminder waiting or one sent in the last 7 days are listed as left out), a risk level with reasons per customer, review, edit, reject or send with human approval, delivery retries, and an audit event for every step. It never sends on its own. Waiting on ANTHROPIC_API_KEY and real SMTP for a live check.
- Evidence:
  - apps/api/src/collections/collections.service.ts
  - apps/api/test/collections.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/sales/collections/page.tsx
  - apps/web/src/app/orgs/[orgId]/sales/collections/[reminderId]/page.tsx
  - apps/web/e2e/collections-flow.test.mjs
  - docs/AI_COLLECTIONS.md

### AGENT-044 — Enforces permissions

- Module: Multi-agent AI finance workforce
- Status: **Implementing**
- Notes: Each agent run needs the starting member's permission for that feature, the organisation's AI switch, the agent's own switch and its budget, checked again before every model call. Not built: an orchestrator assigning work between agents.
- Evidence:
  - apps/api/src/ai-control/ai-control.service.ts
  - apps/api/test/ai-control.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/ai-control/page.tsx
  - apps/web/e2e/ai-control-flow.test.mjs
  - packages/database/prisma/migrations/20261103010000_ai_control_center/migration.sql
  - docs/AI_CONTROL_CENTER.md

### AGENT-046 — Tracks execution status

- Module: Multi-agent AI finance workforce
- Status: **Implementing**
- Notes: Running and failed work per agent in the control center; every call in AI activity. Not built: a single cross-agent task model.
- Evidence:
  - apps/api/src/ai-control/ai-control.service.ts
  - apps/api/test/ai-control.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/ai-control/page.tsx
  - apps/web/e2e/ai-control-flow.test.mjs
  - packages/database/prisma/migrations/20261103010000_ai_control_center/migration.sql
  - docs/AI_CONTROL_CENTER.md
  - apps/web/src/app/orgs/[orgId]/ai-activity/page.tsx

### AGENT-052 — Measures accuracy

- Module: Multi-agent AI finance workforce
- Status: **Tested**
- Notes: Acceptance rate per agent over the last 90 days, from what people did with its proposals: reminders sent (with or without edits) or rejected, bank suggestions accepted or dismissed by a person, adjusting entries posted or rejected. Not built: accuracy against a labelled set.
- Evidence:
  - apps/api/src/ai-control/ai-control.service.ts
  - apps/api/test/ai-control.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/ai-control/page.tsx
  - apps/web/e2e/ai-control-flow.test.mjs
  - packages/database/prisma/migrations/20261103010000_ai_control_center/migration.sql
  - docs/AI_CONTROL_CENTER.md

### AGENT-053 — Tracks model costs

- Module: Multi-agent AI finance workforce
- Status: **Implementing**
- Notes: Tokens in and out tracked per call and per agent per month, with an optional monthly token budget per agent that is enforced before each model call. Not built: converting tokens to money at provider prices.
- Evidence:
  - apps/api/src/ai-control/ai-control.service.ts
  - apps/api/test/ai-control.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/ai-control/page.tsx
  - apps/web/e2e/ai-control-flow.test.mjs
  - packages/database/prisma/migrations/20261103010000_ai_control_center/migration.sql
  - docs/AI_CONTROL_CENTER.md

### AGENT-054 — Level 0: Read-only analysis

- Module: Multi-agent AI finance workforce
- Status: **Tested**
- Notes: The copilot is level 0: it can only run read-only reports; shown in the control center.
- Evidence:
  - apps/api/src/ai-control/ai-control.service.ts
  - apps/api/test/ai-control.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/ai-control/page.tsx
  - apps/web/e2e/ai-control-flow.test.mjs
  - packages/database/prisma/migrations/20261103010000_ai_control_center/migration.sql
  - docs/AI_CONTROL_CENTER.md

### AGENT-056 — Level 2: Prepare changes for approval

- Module: Multi-agent AI finance workforce
- Status: **Tested**
- Notes: Collections, bank reconciliation and month-end close agents are level 2: they prepare reminders, matches and entries that only take effect when a person approves them. The level is fixed in code, not a setting.
- Evidence:
  - apps/api/src/ai-control/ai-control.service.ts
  - apps/api/test/ai-control.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/ai-control/page.tsx
  - apps/web/e2e/ai-control-flow.test.mjs
  - packages/database/prisma/migrations/20261103010000_ai_control_center/migration.sql
  - docs/AI_CONTROL_CENTER.md

### AGENT-060 — Provide an emergency stop and tenant-wide AI disable controls

- Module: Multi-agent AI finance workforce
- Status: **Tested**
- Notes: Organisation-wide emergency stop with a reason (owners and admins), shown in every refusal; every agent checks before each model call, so work already running stops and what it had not reached is marked as not done. Per-agent switches too. Not built: a platform-wide stop across all organisations (only removing the API key does that).
- Evidence:
  - apps/api/src/ai-control/ai-control.service.ts
  - apps/api/test/ai-control.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/ai-control/page.tsx
  - apps/web/e2e/ai-control-flow.test.mjs
  - packages/database/prisma/migrations/20261103010000_ai_control_center/migration.sql
  - docs/AI_CONTROL_CENTER.md
  - apps/api/src/copilot
  - apps/api/test/copilot.e2e.test.ts
  - apps/web/e2e/copilot-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/copilot
  - packages/database/prisma/migrations/20261102090000_ai_copilot

### WFLOW-001 — Create a visual no-code and low-code workflow automation builder

- Module: Autonomous financial workflows
- Status: **Implementing**
- Notes: Form-based builder: one trigger (an event, a schedule, or a date an invoice or bill reaches), conditions that must all hold, and up to five actions (task, email or webhook). No visual canvas, branches or drag and drop yet.
- Evidence:
  - apps/web/e2e/automations-flow.test.mjs
  - apps/web/e2e/automations-schedule-email.test.mjs
  - apps/web/src/app/orgs/[orgId]/automations
  - apps/web/src/components/workflows/editor.tsx

### WFLOW-002 — Trigger-based automation

- Module: Autonomous financial workflows
- Status: **Tested**
- Notes: Eight triggers read from the audit trail (a transactional outbox): invoice or bill posted, invoice or bill voided, customer payment, vendor payment, manual journal, expense claim submitted, alert opened. A workflow acts only on events after it is turned on.
- Evidence:
  - apps/api/src/workflows
  - packages/accounting-engine/test/workflows.test.ts
  - apps/api/test/workflows.e2e.test.ts
  - apps/web/e2e/automations-flow.test.mjs

### WFLOW-003 — Scheduled automation

- Module: Autonomous financial workflows
- Status: **Tested**
- Notes: Three schedule triggers: on a schedule (every day, every week on a weekday, or every month on day 1-28, at a time in India time), an invoice N days overdue, and a bill due in N days. Each acts once per occurrence (unique index on workflow and occurrence), only on times and dates from when it was turned on, so turning one on never sends a backlog. Schedule facts include overdue and outstanding receivables and payables.
- Evidence:
  - packages/accounting-engine/src/workflows.ts
  - apps/api/src/workflows/workflow-runner.service.ts
  - packages/accounting-engine/test/workflows.test.ts
  - apps/api/test/workflow-schedules.e2e.test.ts
  - apps/web/e2e/automations-schedule-email.test.mjs
  - packages/database/prisma/migrations/20261102150000_workflow_schedules_email

### WFLOW-004 — Event-based automation

- Module: Autonomous financial workflows
- Status: **Tested**
- Notes: Runner in the API process (WORKFLOW_RUNNER_INTERVAL_SECONDS) with a per-organisation cursor locked FOR UPDATE SKIP LOCKED; one live run per workflow and event, enforced by a unique index.
- Evidence:
  - apps/api/src/workflows/workflow-runner.service.ts
  - apps/api/src/workflows/workflow-facts.ts
  - apps/api/test/workflows.e2e.test.ts

### WFLOW-005 — Conditional branching

- Module: Autonomous financial workflows
- Status: **Implementing**
- Notes: Conditions on the event’s facts (money, text, date, choice), all of which must hold. No either/or branches yet.
- Evidence:
  - packages/accounting-engine/src/workflows.ts
  - packages/accounting-engine/test/workflows.test.ts
  - apps/api/test/workflows.e2e.test.ts

### WFLOW-006 — Approval workflows

- Module: Autonomous financial workflows
- Status: **Implementing**
- Notes: Single-step approval of sales and purchase drafts by amount. No multi-level chains, escalations or approvals for other record types yet.
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts › approvals
  - apps/web/e2e/approvals-flow.test.mjs

### WFLOW-009 — Notifications

- Module: Autonomous financial workflows
- Status: **Integration pending**
- Notes: Email action: plain-text email to everyone with a role, one member, or the customer or vendor on the record, with {{placeholders}}, amounts like ₹1,50,000.00 and dates like 2 Nov 2026. Sent over SMTP (nodemailer, SMTP_URL and EMAIL_FROM) after the run commits, with the webhook retry schedule for 4xx answers or no answer; 5xx is final. Tests send to a local SMTP server; not yet run against a real mail provider. No SMS, chat or in-app notifications.
- Evidence:
  - apps/api/src/workflows/email.ts
  - apps/api/src/workflows/workflow-runner.service.ts
  - apps/api/test/workflow-schedules.e2e.test.ts
  - apps/web/e2e/automations-schedule-email.test.mjs
  - test-support/smtp-stand-in.mjs

### WFLOW-012 — Webhooks

- Module: Autonomous financial workflows
- Status: **Tested**
- Notes: POST with JSON, signed HMAC-SHA256 (t2t-signature: t=,v1=), same delivery id and bytes on every retry, 10-second timeout, no redirects. Public https only in production: DNS answers are checked and the connection is pinned to the checked address.
- Evidence:
  - apps/api/src/workflows/webhook.ts
  - apps/api/test/webhook.test.ts
  - apps/api/test/workflows.e2e.test.ts
  - apps/web/e2e/automations-flow.test.mjs

### WFLOW-014 — Retry policies

- Module: Autonomous financial workflows
- Status: **Tested**
- Notes: Six attempts: retries after 1 min, 5 min, 30 min, 2 h and 6 h. Webhooks: network errors, timeouts, 408, 429 and 5xx; other answers end the delivery. Emails: no answer or a 4xx SMTP answer; 5xx ends it.
- Evidence:
  - apps/api/test/workflow-schedules.e2e.test.ts
  - apps/api/test/workflows.e2e.test.ts
  - packages/accounting-engine/src/workflows.ts
  - packages/accounting-engine/test/workflows.test.ts

### WFLOW-015 — Failure recovery

- Module: Autonomous financial workflows
- Status: **Tested**
- Notes: Failed runs say which action failed and why; an owner or admin can send a failed webhook or email again from the run log. A task for someone who has left, or an email with no address, fails that action only.
- Evidence:
  - apps/api/src/workflows/workflows.service.ts
  - apps/api/test/workflow-schedules.e2e.test.ts
  - apps/api/test/workflows.e2e.test.ts

### WFLOW-016 — Workflow versioning

- Module: Autonomous financial workflows
- Status: **Tested**
- Notes: A change to trigger, conditions or actions makes a new immutable version (database trigger); runs keep their version; stale edits are refused.
- Evidence:
  - apps/api/src/workflows/workflows.service.ts
  - packages/database/prisma/migrations/20261102120000_workflow_automations
  - apps/api/test/workflows.e2e.test.ts
  - apps/web/e2e/automations-flow.test.mjs

### WFLOW-017 — Workflow testing

- Module: Autonomous financial workflows
- Status: **Tested**
- Notes: Dry run on the latest real event (or a chosen one), the latest time a schedule came round, or a real open invoice or bill: facts, each condition with its actual value, the task and the email each action would make. Webhooks are sent only when asked, marked "test": true; test emails go to the tester only, with [Test] in the subject.
- Evidence:
  - apps/api/src/workflows/workflows.service.ts
  - apps/api/test/workflow-schedules.e2e.test.ts
  - apps/api/test/workflows.e2e.test.ts
  - apps/web/e2e/automations-flow.test.mjs
  - apps/web/e2e/automations-schedule-email.test.mjs

### WFLOW-018 — Execution logs

- Module: Autonomous financial workflows
- Status: **Tested**
- Notes: Run log per workflow: event, version, conditions, each action with its attempts, answers and timings. Runs and actions are append-only in the database.
- Evidence:
  - apps/web/src/app/orgs/[orgId]/automations/[workflowId]
  - apps/api/test/workflows.e2e.test.ts
  - apps/web/e2e/automations-flow.test.mjs

### WFLOW-019 — Invoice becomes overdue → AI assesses risk → Drafts reminder → Checks communication policy → Sends approved reminder → Monitors response → Updates collections dashboard

- Module: Autonomous financial workflows
- Status: **Implementing**
- Notes: Built: overdue invoices → AI risk assessment → drafted reminder → checks against the books → sent only once a person approves. Not built: tracking replies and a collections dashboard beyond the queue; the AI step is waiting on a live key.
- Evidence:
  - apps/api/src/collections/collections.service.ts
  - apps/api/test/collections.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/sales/collections/page.tsx
  - apps/web/src/app/orgs/[orgId]/sales/collections/[reminderId]/page.tsx
  - apps/web/e2e/collections-flow.test.mjs
  - docs/AI_COLLECTIONS.md

### WFLOW-021 — Period approaches closing → Reconciliation tasks generated → Missing records identified → Exceptions investigated → Adjustments proposed → Accountant approves → Reports generated → Period locked

- Module: Autonomous financial workflows
- Status: **Implementing**
- Notes: Built: a checklist worked out from the books (draft journals, unmatched bank lines, trial balance, draft documents, reconciliation, approvals, expense claims, payroll, depreciation, negative cash, AI items waiting, earlier months), tasks for accountants for each open check, an AI review that proposes adjusting entries, approval by a person, closing that locks the period with a certification of the figures, and reopening with a reason. Not built: starting the close automatically as a period ends, and generating the report pack at close.
- Evidence:
  - packages/accounting-engine/src/close.ts
  - packages/accounting-engine/test/close.test.ts
  - apps/api/src/close/close.service.ts
  - apps/api/test/close.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/close/[periodId]/page.tsx
  - apps/web/e2e/close-flow.test.mjs
  - docs/MONTH_END_CLOSE.md

### ENT-001 — Multi-company accounting

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Each company is its own organisation with its own books; a user can belong to many and switch between them. Companies owned or administered by the same user can now be grouped under a parent for group reporting (see ENT-007).
- Evidence:
  - packages/accounting-engine/src/consolidation.ts
  - packages/accounting-engine/test/consolidation.test.ts
  - packages/database/prisma/migrations/20261103130000_consolidation/migration.sql
  - apps/api/src/consolidation/consolidation.service.ts
  - apps/api/src/consolidation/consolidation.controller.ts
  - apps/api/test/consolidation.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/consolidation
  - apps/web/e2e/consolidation-flow.test.mjs
  - docs/CONSOLIDATION.md

### ENT-002 — Multi-entity accounting

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Groups of entities owned by a parent organisation: owners and admins add the companies they also own or administer; consolidated reports need report access in every member, and each member's figures are read inside its own tenant context (row-level security applies).
- Evidence:
  - packages/accounting-engine/src/consolidation.ts
  - packages/accounting-engine/test/consolidation.test.ts
  - packages/database/prisma/migrations/20261103130000_consolidation/migration.sql
  - apps/api/src/consolidation/consolidation.service.ts
  - apps/api/src/consolidation/consolidation.controller.ts
  - apps/api/test/consolidation.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/consolidation
  - apps/web/e2e/consolidation-flow.test.mjs
  - docs/CONSOLIDATION.md

### ENT-007 — Consolidated financial statements

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Consolidation worksheet (per company, eliminations, consolidated) and consolidated profit and loss and balance sheet for any period, combined by account code, with CSV/Excel/PDF export audited with the file hash. Full consolidation only (every member treated as 100% owned).
- Evidence:
  - packages/accounting-engine/src/consolidation.ts
  - packages/accounting-engine/test/consolidation.test.ts
  - packages/database/prisma/migrations/20261103130000_consolidation/migration.sql
  - apps/api/src/consolidation/consolidation.service.ts
  - apps/api/src/consolidation/consolidation.controller.ts
  - apps/api/test/consolidation.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/consolidation
  - apps/web/e2e/consolidation-flow.test.mjs
  - docs/CONSOLIDATION.md

### ENT-008 — Intercompany transactions

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Charges and settlements posted in both companies in one database transaction, reversed together, and eliminated by their exact amounts. Journals only: no GST/VAT, stock or unrealised profit.
- Evidence:
  - packages/accounting-engine/src/consolidation.ts (intercompanyEliminations, ledger eliminations)
  - packages/database/prisma/migrations/20261103180000_intercompany/migration.sql
  - apps/api/src/consolidation/intercompany.service.ts
  - apps/web/src/components/consolidation/intercompany.tsx
  - packages/accounting-engine/test/consolidation.test.ts
  - apps/api/test/intercompany.e2e.test.ts
  - apps/web/e2e/intercompany-flow.test.mjs
  - docs/CONSOLIDATION.md

### ENT-009 — Intercompany elimination

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Elimination rules pair one member's account with another's (current accounts, intercompany sales and purchases, investment and share capital), checked against each member's chart of accounts. Both balances are removed; a mismatch stays visible in an 'Intercompany differences to resolve' line and the worksheet still balances. Intercompany balances must sit on dedicated accounts (AR/AP control accounts cannot be split).
- Evidence:
  - packages/accounting-engine/src/consolidation.ts
  - packages/accounting-engine/test/consolidation.test.ts
  - packages/database/prisma/migrations/20261103130000_consolidation/migration.sql
  - apps/api/src/consolidation/consolidation.service.ts
  - apps/api/src/consolidation/consolidation.controller.ts
  - apps/api/test/consolidation.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/consolidation
  - apps/web/e2e/consolidation-flow.test.mjs
  - docs/CONSOLIDATION.md

### ENT-010 — Minority interest support

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Outside share of the subsidiary's reported net assets and profit; no goodwill, fair value adjustments or indirect holdings. See docs/CONSOLIDATION.md.
- Evidence:
  - packages/accounting-engine/src/consolidation.ts (ownershipPercent, non-controlling net assets and profit)
  - PUT v1/orgs/:orgId/consolidation/groups/:groupId/members/:memberOrgId
  - apps/web group consolidation page: share column, split lines
  - packages/accounting-engine/test/consolidation.test.ts
  - apps/api/test/consolidation.e2e.test.ts
  - apps/web/e2e/consolidation-flow.test.mjs

### ENT-011 — Foreign currency translation

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Members in another currency are translated with user-entered rates per period end: assets and liabilities at closing, revenue and expenses at average, equity and earnings brought forward at a historical rate, with the difference in a foreign currency translation reserve. Rates are not fetched from a market source.
- Evidence:
  - packages/accounting-engine/src/consolidation.ts
  - packages/accounting-engine/test/consolidation.test.ts
  - packages/database/prisma/migrations/20261103130000_consolidation/migration.sql
  - apps/api/src/consolidation/consolidation.service.ts
  - apps/api/src/consolidation/consolidation.controller.ts
  - apps/api/test/consolidation.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/consolidation
  - apps/web/e2e/consolidation-flow.test.mjs
  - docs/CONSOLIDATION.md

### ENT-012 — Group reporting

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Group reporting through consolidation groups: worksheet, consolidated P&L and balance sheet, elimination status and translation summary on one page, exportable.
- Evidence:
  - packages/accounting-engine/src/consolidation.ts
  - packages/accounting-engine/test/consolidation.test.ts
  - packages/database/prisma/migrations/20261103130000_consolidation/migration.sql
  - apps/api/src/consolidation/consolidation.service.ts
  - apps/api/src/consolidation/consolidation.controller.ts
  - apps/api/test/consolidation.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/consolidation
  - apps/web/e2e/consolidation-flow.test.mjs
  - docs/CONSOLIDATION.md

### ENT-014 — Financial dimensions

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Departments and projects as masters (code unique per kind, never deleted, made inactive instead) tagging journal, invoice, credit note, bill and vendor credit lines; tags checked by organisation, kind and active state in the API and by the database, carried from document lines to the journal and kept on reversals. Not built: more than two dimensions, cost allocation across departments, splitting one line across projects.
- Evidence:
  - packages/accounting-engine/src/dimensions.ts
  - packages/accounting-engine/test/dimensions.test.ts
  - apps/api/src/dimensions/dimensions.service.ts
  - apps/api/src/dimensions/check.ts
  - apps/api/test/dimensions.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/dimensions/page.tsx
  - apps/web/src/components/dimensions/line-dimensions.tsx
  - apps/web/e2e/dimensions-flow.test.mjs
  - packages/database/prisma/migrations/20261103070000_financial_dimensions/migration.sql
  - docs/FINANCIAL_DIMENSIONS.md

### ENT-016 — Deferred revenue

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Deferred revenue schedules: receipt posted to a liability (2350 Deferred Revenue in the standard chart) or already in the books, released to revenue evenly by month or by days in one monthly journal with catch-up, latest-first reversal, ended early with what is left to revenue or refunded; month-end close warns about unposted releases. Not built: schedules created from invoice lines, recognition by milestone, usage or performance obligation (Ind AS 115 beyond straight-line over time).
- Evidence:
  - packages/accounting-engine/src/deferrals.ts
  - packages/accounting-engine/test/deferrals.test.ts
  - apps/api/src/deferrals/deferrals.service.ts
  - apps/api/test/deferrals.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/deferrals
  - apps/web/e2e/deferrals-flow.test.mjs
  - packages/database/prisma/migrations/20261103050000_prepaid_deferred_accruals/migration.sql
  - docs/PREPAID_AND_DEFERRED.md

### ENT-017 — Prepaid expenses

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Prepaid expense schedules: payment posted to a prepaid account or already in the books, released to expense evenly by month or by days in one monthly journal with catch-up, latest-first reversal, ended early with what is left expensed or moved to a refund account. Not built: schedules created from bill lines, foreign-currency schedules.
- Evidence:
  - packages/accounting-engine/src/deferrals.ts
  - packages/accounting-engine/test/deferrals.test.ts
  - apps/api/src/deferrals/deferrals.service.ts
  - apps/api/test/deferrals.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/deferrals
  - apps/web/e2e/deferrals-flow.test.mjs
  - packages/database/prisma/migrations/20261103050000_prepaid_deferred_accruals/migration.sql
  - docs/PREPAID_AND_DEFERRED.md

### ENT-018 — Accruals

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Month-end accruals of expense or income: posted on the last day of the month with the automatic reversal on the first day of the next; cancelling posts the opposite entries on both dates. Not built: recurring accruals, other reversal dates, accruals suggested from history (the month-end close AI review can propose accrual entries separately).
- Evidence:
  - apps/api/src/deferrals/deferrals.service.ts
  - apps/api/test/deferrals.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/accruals/page.tsx
  - apps/web/e2e/deferrals-flow.test.mjs
  - docs/PREPAID_AND_DEFERRED.md

### ENT-019 — Fixed asset management

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Fixed asset register: assets with category, serial number, location, accounts, cost, residual value and dates; purchase posted from the register or already in the books; assets brought in part-depreciated; terms fixed once depreciation is posted (database trigger); disposal with proceeds and gain or loss posted. Not built: asset categories with default terms, transfers between locations, revaluation, impairment, partial disposal, tagging or photos.
- Evidence:
  - packages/accounting-engine/src/fixed-assets.ts
  - packages/accounting-engine/test/fixed-assets.test.ts
  - apps/api/src/fixed-assets/fixed-assets.service.ts
  - apps/api/test/fixed-assets.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/fixed-assets
  - apps/web/e2e/fixed-assets-flow.test.mjs
  - packages/database/prisma/migrations/20261103030000_fixed_assets/migration.sql
  - docs/FIXED_ASSETS.md

### ENT-020 — Depreciation

- Module: Enterprise financial management
- Status: **Tested**
- Notes: Straight-line and written-down-value depreciation by month, posted once a month as one journal (catching up missed months), reversible latest first; schedules per asset. Not tested against a published depreciation schedule (for example Companies Act Schedule II rates); no separate tax-book (Income Tax Act block) depreciation.
- Evidence:
  - packages/accounting-engine/src/fixed-assets.ts
  - packages/accounting-engine/test/fixed-assets.test.ts
  - apps/api/src/fixed-assets/fixed-assets.service.ts
  - apps/api/test/fixed-assets.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/fixed-assets
  - apps/web/e2e/fixed-assets-flow.test.mjs
  - packages/database/prisma/migrations/20261103030000_fixed_assets/migration.sql
  - docs/FIXED_ASSETS.md

### RISK-001 — Duplicate invoice detection

- Module: Financial fraud and risk intelligence
- Status: **Tested**
- Notes: Possible duplicate bill (same vendor, same total, within N days, under different invoice numbers) and possible duplicate payment (same vendor, same amount, within N days). The same vendor invoice number is refused at entry (AP-018).
- Evidence:
  - packages/accounting-engine/src/alerts.ts
  - packages/accounting-engine/test/alerts.test.ts
  - apps/api/src/alerts
  - apps/api/test/alerts.e2e.test.ts
  - apps/web/e2e/alerts-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/alerts

### RISK-004 — Unusual journal detection

- Module: Financial fraud and risk intelligence
- Status: **Tested**
- Notes: Manual journals posted in the last 90 days that are N times the median manual journal of the year before (with a minimum amount), or posted more than N days after their date.
- Evidence:
  - packages/accounting-engine/src/alerts.ts
  - packages/accounting-engine/test/alerts.test.ts
  - apps/api/src/alerts
  - apps/api/test/alerts.e2e.test.ts
  - apps/web/e2e/alerts-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/alerts

### RISK-012 — Customer concentration risk

- Module: Financial fraud and risk intelligence
- Status: **Tested**
- Notes: Revenue by customer from posted invoices less credit notes (tax excluded) over the last 12 months and per month: top 5 with shares, the rest grouped, and a warning when one customer is 40% or more. No alerts or scoring.
- Evidence:
  - packages/accounting-engine/src/kpis.ts
  - packages/accounting-engine/test/kpis.test.ts
  - apps/api/src/kpis
  - apps/api/test/kpis.e2e.test.ts
  - apps/web/e2e/kpis-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/reports/kpis

### RISK-018 — Provide evidence and reasons for alerts

- Module: Financial fraud and risk intelligence
- Status: **Tested**
- Notes: Every alert stores the figures and records it was raised on (facts, linked records, a table) and the check description; history of every state change.
- Evidence:
  - packages/accounting-engine/src/alerts.ts
  - packages/accounting-engine/test/alerts.test.ts
  - apps/api/src/alerts
  - apps/api/test/alerts.e2e.test.ts
  - apps/web/e2e/alerts-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/alerts

### RISK-019 — Do not automatically accuse individuals of fraud

- Module: Financial fraud and risk intelligence
- Status: **Tested**
- Notes: Alerts are worded as things to check, never as accusations; dismissing needs a reason and is kept in the history and audit trail.
- Evidence:
  - packages/accounting-engine/src/alerts.ts
  - packages/accounting-engine/test/alerts.test.ts
  - apps/api/src/alerts
  - apps/api/test/alerts.e2e.test.ts
  - apps/web/e2e/alerts-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/alerts

### AUDIT-004 — Audit trails

- Module: Continuous audit and governance
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › audit trail
  - GET /v1/orgs/:orgId/audit-events, /verify
  - apps/web/src/app/orgs/[orgId]/audit
  - apps/web/e2e/ledger-flow.test.mjs

### AUDIT-005 — Transaction history

- Module: Continuous audit and governance
- Status: **Implemented**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts
  - apps/web/src

### AUDIT-006 — Approval history

- Module: Continuous audit and governance
- Status: **Tested**
- Notes: Every request, decision, withdrawal and cancellation is kept (never deleted, trigger-enforced) and audited.
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts
  - apps/web/src/components/approvals/approval-card.tsx

### AUDIT-010 — Exception tracking

- Module: Continuous audit and governance
- Status: **Tested**
- Notes: Alerts are tracked per finding: open, acknowledged, dismissed (with reason) or cleared when no longer found; reopen on recurrence; append-only history and audit events.
- Evidence:
  - packages/accounting-engine/src/alerts.ts
  - packages/accounting-engine/test/alerts.test.ts
  - apps/api/src/alerts
  - apps/api/test/alerts.e2e.test.ts
  - apps/web/e2e/alerts-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/alerts

### AUDIT-015 — Period-close certification

- Module: Continuous audit and governance
- Status: **Tested**
- Notes: Closing a month records a certification: who closed it and when, the checklist as it stood (with the warnings accepted and the note saying why), and the month's totals (revenue, expenses, net profit, assets, liabilities, trial balance, journals posted). Only owners and admins can close or reopen; a database trigger keeps a certification unchanged except for recording one reopening with its reason, and an unlock on the periods page is refused while the close stands.
- Evidence:
  - apps/api/src/close/close.service.ts
  - apps/api/test/close.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/close/[periodId]/page.tsx
  - apps/web/e2e/close-flow.test.mjs
  - packages/database/prisma/migrations/20261102230000_month_end_close/migration.sql
  - docs/MONTH_END_CLOSE.md

### AUDIT-016 — AI action history

- Module: Continuous audit and governance
- Status: **Tested**
- Notes: Copilot conversations keep each answer with the reports it read; finished messages cannot be changed (database trigger).
- Evidence:
  - apps/api/src/copilot
  - apps/api/test/copilot.e2e.test.ts
  - apps/web/e2e/copilot-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/copilot
  - packages/database/prisma/migrations/20261102090000_ai_copilot

### AUDIT-019 — Model version

- Module: Continuous audit and governance
- Status: **Tested**
- Notes: AI activity page (Governance): every copilot answer and reminder draft shows the model asked and the model that answered, from the provider response.
- Evidence:
  - apps/api/src/collections/collections.service.ts
  - apps/api/test/collections.e2e.test.ts
  - apps/web/e2e/collections-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/ai-activity/page.tsx

### AUDIT-022 — Proposed action

- Module: Continuous audit and governance
- Status: **Tested**
- Notes: Every AI proposal is kept as proposed (bank suggestions: the action and references the model sent, and the resolved records; reminders: the text the model wrote), frozen by database triggers, next to what a person decided. Month-end close entries keep the lines, reason and confidence the model proposed, frozen the same way.
- Evidence:
  - apps/api/src/bank-ai/bank-ai.service.ts
  - apps/api/src/collections/collections.service.ts
  - apps/api/test/bank-ai.e2e.test.ts
  - apps/api/test/collections.e2e.test.ts
  - apps/web/e2e/bank-ai-flow.test.mjs
  - apps/api/src/close/close.service.ts
  - apps/api/test/close.e2e.test.ts

### AUDIT-023 — Reasoning summary

- Module: Continuous audit and governance
- Status: **Tested**
- Notes: Each AI proposal stores and shows the model's own short reason (bank suggestions) or risk reasons (reminders), with the checks run on it. These are the model's stated reasons, not its internal reasoning. Month-end close entries keep the lines, reason and confidence the model proposed, frozen the same way.
- Evidence:
  - apps/api/src/bank-ai/bank-ai.service.ts
  - apps/api/src/collections/collections.service.ts
  - apps/web/src/app/orgs/[orgId]/banking/[accountId]/ai/page.tsx
  - apps/web/src/app/orgs/[orgId]/sales/collections/[reminderId]/page.tsx
  - apps/api/src/close/close.service.ts
  - apps/api/test/close.e2e.test.ts

### AUDIT-024 — Approval status

- Module: Continuous audit and governance
- Status: **Tested**
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts
  - apps/web/e2e/approvals-flow.test.mjs

### AUDIT-025 — Approving user

- Module: Continuous audit and governance
- Status: **Tested**
- Notes: Approver name, time and note are stored on the request; the approver must differ from the preparer when the rule says so (database-enforced).
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts
  - apps/web/e2e/approvals-flow.test.mjs

### AUDIT-026 — Execution result

- Module: Continuous audit and governance
- Status: **Tested**
- Notes: AI activity page: the outcome of each AI call (answered, declined, failed, drafted) with tokens used, and for reminders what a person decided (sent, sent with edits, rejected, not delivered).
- Evidence:
  - apps/api/src/collections/collections.service.ts
  - apps/api/test/collections.e2e.test.ts
  - apps/web/e2e/collections-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/ai-activity/page.tsx

### AUDIT-028 — Relevant evidence references

- Module: Continuous audit and governance
- Status: **Implementing**
- Notes: Evidence files are linked to the records they support with a SHA-256 checksum. Audit-event-level evidence references are not modelled yet.
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts

### DOC-001 — Create a secure financial document management system

- Module: Document intelligence
- Status: **Implementing**
- Notes: Files attach to invoices, bills, payments, journals and bank lines; stored in PostgreSQL with checksum, type detected from bytes, immutable, soft removal with reason. No standalone document vault, folders or search yet.
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts
  - apps/api/src/attachments
  - apps/web/src/components/attachments.tsx

### DOC-002 — Invoices

- Module: Document intelligence
- Status: **Tested**
- Notes: Invoice and bill files attached to the document record.
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts › attachments
  - apps/web/e2e/approvals-flow.test.mjs
  - POST /v1/orgs/:orgId/attachments

### DOC-003 — Receipts

- Module: Document intelligence
- Status: **Tested**
- Notes: Receipts attach to documents, payments and journal entries.
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts › attachments
  - apps/web/e2e/approvals-flow.test.mjs

### DOC-006 — Bank statements

- Module: Document intelligence
- Status: **Implementing**
- Notes: Files can be attached to bank statement lines through the API; no screen for it yet. Statement CSV import itself is BANK-*.
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts
  - POST /v1/orgs/:orgId/attachments (entityType BANK_STATEMENT_LINE)

### DOC-018 — Duplicate detection

- Module: Document intelligence
- Status: **Implementing**
- Notes: Exact duplicate files (same SHA-256) on the same record are refused. No cross-record or fuzzy duplicate detection.
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts › checks the bytes, not the claimed type, and refuses empty, oversized and duplicate files

### RPT-013 — Project profitability

- Module: Advanced financial reporting
- Status: **Tested**
- Notes: Project profitability: revenue, expenses, net profit and margin per project for any date range. Not built: budget vs actual per project, work in progress, percentage of completion.
- Evidence:
  - apps/api/src/dimensions/dimensions.service.ts
  - apps/api/test/dimensions.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/reports/profit-by-dimension/page.tsx
  - apps/web/src/app/orgs/[orgId]/reports/income-statement/page.tsx
  - apps/web/e2e/dimensions-flow.test.mjs
  - docs/FINANCIAL_DIMENSIONS.md

### RPT-014 — Department profitability

- Module: Advanced financial reporting
- Status: **Tested**
- Notes: Department profitability: revenue, expenses, net profit and margin per department for any date range, with untagged activity under Not assigned.
- Evidence:
  - apps/api/src/dimensions/dimensions.service.ts
  - apps/api/test/dimensions.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/reports/profit-by-dimension/page.tsx
  - apps/web/src/app/orgs/[orgId]/reports/income-statement/page.tsx
  - apps/web/e2e/dimensions-flow.test.mjs
  - docs/FINANCIAL_DIMENSIONS.md

### RPT-018 — Working capital

- Module: Advanced financial reporting
- Status: **Tested**
- Notes: Working capital (current assets − current liabilities at month end), with current and quick ratio, DSO and DPO and their history. Classification by account subtype; an unclassified liability counts as current.
- Evidence:
  - packages/accounting-engine/src/kpis.ts
  - packages/accounting-engine/test/kpis.test.ts
  - apps/api/src/kpis
  - apps/api/test/kpis.e2e.test.ts
  - apps/web/e2e/kpis-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/reports/kpis

### RPT-019 — Financial ratios

- Module: Advanced financial reporting
- Status: **Tested**
- Notes: Financial ratios: margins, operating expense ratio, current and quick ratio, liabilities to equity, DSO and DPO, from posted journals by account subtype, with the figures behind each. DSO/DPO compare GST-inclusive balances with tax-exclusive revenue/expenses (documented).
- Evidence:
  - packages/accounting-engine/src/kpis.ts
  - packages/accounting-engine/test/kpis.test.ts
  - apps/api/src/kpis
  - apps/api/test/kpis.e2e.test.ts
  - apps/web/e2e/kpis-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/reports/kpis

### RPT-024 — Board reports

- Module: Advanced financial reporting
- Status: **Tested**
- Notes: Monthly management report: grouped P&L for the month vs previous month, same month last year and the approved budget, year to date, cash, KPIs and top customers, with commentary. Finalising freezes figures and commentary (trigger); later postings are listed against it. Printable from the browser; no PDF export, scheduling or distribution yet.
- Evidence:
  - packages/accounting-engine/src/kpis.ts
  - packages/accounting-engine/test/kpis.test.ts
  - apps/api/src/kpis
  - apps/api/test/kpis.e2e.test.ts
  - apps/web/e2e/kpis-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/reports/management
  - packages/database/prisma/migrations/20261101300000_kpis_management_reports

### RPT-027 — Financial dimensions

- Module: Advanced financial reporting
- Status: **Tested**
- Notes: Profit and loss with a column per department or project plus Not assigned, totals, net profit and margin per column; the profit and loss filtered by department and project. Not built: trial balance, balance sheet, general ledger and budgets by dimension.
- Evidence:
  - apps/api/src/dimensions/dimensions.service.ts
  - apps/api/test/dimensions.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/reports/profit-by-dimension/page.tsx
  - apps/web/src/app/orgs/[orgId]/reports/income-statement/page.tsx
  - apps/web/e2e/dimensions-flow.test.mjs
  - docs/FINANCIAL_DIMENSIONS.md

### RPT-033 — PDF exports

- Module: Advanced financial reporting
- Status: **Tested**
- Notes: PDF export of the trial balance, profit and loss, balance sheet, general ledger, receivables and payables ageing, and profit by department or project from an Export button on each report page. A4 with landscape for wide reports, header row repeated on every page, bold subtotals and totals with rules, notes, footer with page numbers, lakh/crore grouping for INR. Uses the PDF standard fonts, so characters outside Western European scripts print as '?'. Every export is audited (report.exported) with the file's SHA-256.
- Evidence:
  - packages/accounting-engine/src/report-export.ts
  - packages/accounting-engine/test/report-export.test.ts
  - apps/api/src/report-exports/report-exports.service.ts
  - apps/api/src/report-exports/pdf.ts
  - apps/api/src/report-exports/report-exports.controller.ts
  - apps/api/test/report-exports.e2e.test.ts
  - apps/web/src/components/reports/export-buttons.tsx
  - apps/web/e2e/report-exports-flow.test.mjs
  - docs/REPORT_EXPORTS.md

### RPT-034 — Excel exports

- Module: Advanced financial reporting
- Status: **Tested**
- Notes: Excel (.xlsx) export of the trial balance, profit and loss, balance sheet, general ledger, receivables and payables ageing, and profit by department or project. Amounts are real numbers with a currency format (lakh/crore grouping chosen per cell for INR, checked in LibreOffice), dates are Excel dates, frozen header, bold totals, notes. Written without dependencies (stored ZIP). Text is never written as a formula.
- Evidence:
  - packages/accounting-engine/src/report-export.ts
  - packages/accounting-engine/test/report-export.test.ts
  - apps/api/src/report-exports/report-exports.service.ts
  - apps/api/src/report-exports/pdf.ts
  - apps/api/src/report-exports/report-exports.controller.ts
  - apps/api/test/report-exports.e2e.test.ts
  - apps/web/src/components/reports/export-buttons.tsx
  - apps/web/e2e/report-exports-flow.test.mjs
  - docs/REPORT_EXPORTS.md

### RPT-035 — CSV exports

- Module: Advanced financial reporting
- Status: **Tested**
- Notes: CSV export of the trial balance, profit and loss, balance sheet, general ledger, receivables and payables ageing, and profit by department or project: UTF-8 with BOM, CRLF, RFC 4180 quoting, amounts as plain decimals, and text that a spreadsheet would run as a formula (=, +, -, @) prefixed with an apostrophe.
- Evidence:
  - packages/accounting-engine/src/report-export.ts
  - packages/accounting-engine/test/report-export.test.ts
  - apps/api/src/report-exports/report-exports.service.ts
  - apps/api/src/report-exports/pdf.ts
  - apps/api/src/report-exports/report-exports.controller.ts
  - apps/api/test/report-exports.e2e.test.ts
  - apps/web/src/components/reports/export-buttons.tsx
  - apps/web/e2e/report-exports-flow.test.mjs
  - docs/REPORT_EXPORTS.md

### DASH-013 — Create an original visual identity for Sampledge Talk2Tax

- Module: Dashboard design
- Status: **Implementing**
- Notes: Original palette and wordmark in packages/design-system; full brand system and illustration set not done.
- Evidence:
  - apps/web/src

### DASH-014 — Deep midnight navy

- Module: Dashboard design
- Status: **Tested**
- Notes: Colour token defined and checked for WCAG AA contrast.
- Evidence:
  - packages/design-system/src/tokens.ts
  - packages/design-system/test/contrast.test.mjs

### DASH-015 — Electric cyan

- Module: Dashboard design
- Status: **Tested**
- Notes: Colour token defined and checked for WCAG AA contrast.
- Evidence:
  - packages/design-system/src/tokens.ts
  - packages/design-system/test/contrast.test.mjs

### DASH-016 — Rich indigo

- Module: Dashboard design
- Status: **Tested**
- Notes: Colour token defined and checked for WCAG AA contrast.
- Evidence:
  - packages/design-system/src/tokens.ts
  - packages/design-system/test/contrast.test.mjs

### DASH-017 — Emerald green

- Module: Dashboard design
- Status: **Tested**
- Notes: Colour token defined and checked for WCAG AA contrast.
- Evidence:
  - packages/design-system/src/tokens.ts
  - packages/design-system/test/contrast.test.mjs

### DASH-018 — Soft violet

- Module: Dashboard design
- Status: **Tested**
- Notes: Colour token defined and checked for WCAG AA contrast.
- Evidence:
  - packages/design-system/src/tokens.ts
  - packages/design-system/test/contrast.test.mjs

### DASH-019 — Warm amber for warnings

- Module: Dashboard design
- Status: **Tested**
- Notes: Colour token defined and checked for WCAG AA contrast.
- Evidence:
  - packages/design-system/src/tokens.ts
  - packages/design-system/test/contrast.test.mjs

### DASH-020 — Neutral white and graphite

- Module: Dashboard design
- Status: **Tested**
- Notes: Colour token defined and checked for WCAG AA contrast.
- Evidence:
  - packages/design-system/src/tokens.ts
  - packages/design-system/test/contrast.test.mjs

### DASH-040 — All critical figures must also be available in accurate 2D charts and accessible tables

- Module: Dashboard design
- Status: **Implementing**
- Notes: Dashboard chart has a matching data table; other charts are not built yet.
- Evidence:
  - apps/web/src

### DASH-041 — Respect reduced-motion preferences

- Module: Dashboard design
- Status: **Implemented**
- Notes: Chart animation and CSS transitions are disabled under prefers-reduced-motion.
- Evidence:
  - apps/web/src

### WAR-001 — Create an immersive collaborative financial planning environment

- Module: AI financial war room
- Status: **Implementing**
- Notes: One page per scenario where the team works together: model, impacts, suggestions, notes, versions and approval. Not live: others see changes on reload, with no presence or live cursors.
- Evidence:
  - packages/accounting-engine/src/twin-insights.ts
  - packages/database/prisma/migrations/20261103220000_war_room/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/twin/[scenarioId]/page.tsx
  - packages/accounting-engine/test/twin-insights.test.ts
  - apps/api/test/war-room.e2e.test.ts
  - apps/web/e2e/war-room-flow.test.mjs
  - docs/WAR_ROOM.md

### WAR-002 — Scenario comparison

- Module: AI financial war room
- Status: **Tested**
- Notes: Up to five saved scenarios side by side with the no-change baseline, now with approval status and a risk map.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md
  - apps/web/src/app/orgs/[orgId]/planning/twin/compare/page.tsx

### WAR-003 — Financial simulations

- Module: AI financial war room
- Status: **Tested**
- Notes: Driver-based monthly simulations played forward from the posted books (see the digital twin).
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### WAR-004 — Cash-flow projections

- Module: AI financial war room
- Status: **Tested**
- Notes: Monthly closing cash, lowest cash, cash to raise and the month cash runs out, for every scenario.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### WAR-005 — Strategic planning boards

- Module: AI financial war room
- Status: **Tested**
- Notes: Planning board: scenarios in Draft, Waiting for approval, Approved and Rejected columns, with version, open notes and who submitted or decided.
- Evidence:
  - packages/accounting-engine/src/twin-insights.ts
  - packages/database/prisma/migrations/20261103220000_war_room/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/twin/[scenarioId]/page.tsx
  - packages/accounting-engine/test/twin-insights.test.ts
  - apps/api/test/war-room.e2e.test.ts
  - apps/web/e2e/war-room-flow.test.mjs
  - docs/WAR_ROOM.md
  - apps/web/src/app/orgs/[orgId]/planning/twin/page.tsx

### WAR-006 — Risk maps

- Module: AI financial war room
- Status: **Tested**
- Notes: Risk map on the comparison page: each risk the engine finds, by scenario, with its level and details.
- Evidence:
  - packages/accounting-engine/src/twin-insights.ts
  - packages/database/prisma/migrations/20261103220000_war_room/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/twin/[scenarioId]/page.tsx
  - packages/accounting-engine/test/twin-insights.test.ts
  - apps/api/test/war-room.e2e.test.ts
  - apps/web/e2e/war-room-flow.test.mjs
  - docs/WAR_ROOM.md
  - apps/web/src/app/orgs/[orgId]/planning/twin/compare/page.tsx

### WAR-008 — Departmental financial impact

- Module: AI financial war room
- Status: **Tested**
- Notes: Each change can belong to a department; the war room shows the measured net profit and cash effect of each change and the total by department.
- Evidence:
  - packages/accounting-engine/src/twin-insights.ts
  - packages/database/prisma/migrations/20261103220000_war_room/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/twin/[scenarioId]/page.tsx
  - packages/accounting-engine/test/twin-insights.test.ts
  - apps/api/test/war-room.e2e.test.ts
  - apps/web/e2e/war-room-flow.test.mjs
  - docs/WAR_ROOM.md

### WAR-009 — Investment scenarios

- Module: AI financial war room
- Status: **Tested**
- Notes: Investment changes (equipment bought and depreciated) and new loans in scenarios.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### WAR-010 — Business expansion scenarios

- Module: AI financial war room
- Status: **Tested**
- Notes: Expansion changes: one-off cost, running costs and revenue ramping up to full speed.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md

### WAR-011 — Collaborative annotations

- Module: AI financial war room
- Status: **Tested**
- Notes: Notes on a scenario, optionally pinned to a projected month and a change, recorded against the version; resolve by the author or a scenario manager, delete by the author; open notes counted on the board.
- Evidence:
  - packages/accounting-engine/src/twin-insights.ts
  - packages/database/prisma/migrations/20261103220000_war_room/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/twin/[scenarioId]/page.tsx
  - packages/accounting-engine/test/twin-insights.test.ts
  - apps/api/test/war-room.e2e.test.ts
  - apps/web/e2e/war-room-flow.test.mjs
  - docs/WAR_ROOM.md

### WAR-012 — Approval workflows

- Module: AI financial war room
- Status: **Tested**
- Notes: Submit, withdraw, approve, reject (with a reason) and reopen; frozen while waiting or approved; the submitter cannot decide; new permission scenarios.approve (owners, admins, approvers); every step audited.
- Evidence:
  - packages/accounting-engine/src/twin-insights.ts
  - packages/database/prisma/migrations/20261103220000_war_room/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/twin/[scenarioId]/page.tsx
  - packages/accounting-engine/test/twin-insights.test.ts
  - apps/api/test/war-room.e2e.test.ts
  - apps/web/e2e/war-room-flow.test.mjs
  - docs/WAR_ROOM.md

### WAR-013 — Scenario version history

- Module: AI financial war room
- Status: **Tested**
- Notes: Every saved set of inputs is an immutable version with who and why; restoring makes an earlier version the newest.
- Evidence:
  - packages/accounting-engine/src/twin-insights.ts
  - packages/database/prisma/migrations/20261103220000_war_room/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/twin/[scenarioId]/page.tsx
  - packages/accounting-engine/test/twin-insights.test.ts
  - apps/api/test/war-room.e2e.test.ts
  - apps/web/e2e/war-room-flow.test.mjs
  - docs/WAR_ROOM.md

### WAR-014 — Left: Assumptions and controls

- Module: AI financial war room
- Status: **Tested**
- Notes: Left column: scenario settings and the changes, each with its department.
- Evidence:
  - packages/accounting-engine/src/twin-insights.ts
  - packages/database/prisma/migrations/20261103220000_war_room/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/twin/[scenarioId]/page.tsx
  - packages/accounting-engine/test/twin-insights.test.ts
  - apps/api/test/war-room.e2e.test.ts
  - apps/web/e2e/war-room-flow.test.mjs
  - docs/WAR_ROOM.md

### WAR-015 — Center: Interactive financial model

- Module: AI financial war room
- Status: **Tested**
- Notes: Centre: the projection updating as changes are typed, chart, risks, inputs to confirm, impacts and month table.
- Evidence:
  - packages/accounting-engine/src/twin-insights.ts
  - packages/database/prisma/migrations/20261103220000_war_room/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/twin/[scenarioId]/page.tsx
  - packages/accounting-engine/test/twin-insights.test.ts
  - apps/api/test/war-room.e2e.test.ts
  - apps/web/e2e/war-room-flow.test.mjs
  - docs/WAR_ROOM.md

### WAR-016 — Right: AI recommendations, risks and explanations

- Module: AI financial war room
- Status: **Implementing**
- Notes: Suggested next moves (fund the gap, collect sooner, price rise, delay the largest cost, set the tax rate) measured by re-running the model, plus risks and assumptions in words. Rule-based, not written by AI yet.
- Evidence:
  - packages/accounting-engine/src/twin-insights.ts
  - packages/database/prisma/migrations/20261103220000_war_room/migration.sql
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/twin/[scenarioId]/page.tsx
  - packages/accounting-engine/test/twin-insights.test.ts
  - apps/api/test/war-room.e2e.test.ts
  - apps/web/e2e/war-room-flow.test.mjs
  - docs/WAR_ROOM.md

### WAR-017 — Executives should be able to compare multiple scenarios simultaneously

- Module: AI financial war room
- Status: **Tested**
- Notes: Compare up to five scenarios at once.
- Evidence:
  - packages/accounting-engine/src/twin.ts
  - apps/api/src/twin/twin.service.ts
  - apps/web/src/components/twin/scenario-builder.tsx
  - apps/api/test/twin.e2e.test.ts
  - apps/web/e2e/twin-flow.test.mjs
  - docs/DIGITAL_TWIN.md
  - apps/web/src/app/orgs/[orgId]/planning/twin/compare/page.tsx

### RECOV-001 — Create an AI-assisted business financial recovery workspace

- Module: Financial recovery planner
- Status: **Implementing**
- Notes: Recovery workspace: options from the books, plans with owners, due dates, status and notes, liquidity forecast, and copying into a twin scenario. Rule-based, not AI-assisted yet.
- Evidence:
  - packages/accounting-engine/src/recovery.ts
  - packages/database/prisma/migrations/20261104090000_recovery_planner/migration.sql
  - apps/api/src/recovery/recovery.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/recovery/[planId]/page.tsx
  - packages/accounting-engine/test/recovery.test.ts
  - apps/api/test/recovery.e2e.test.ts
  - apps/web/e2e/recovery-flow.test.mjs
  - docs/RECOVERY_PLANNER.md

### RECOV-002 — Cash conservation scenarios

- Module: Financial recovery planner
- Status: **Tested**
- Notes: Spending freeze option (other operating costs -10%) measured on the twin.
- Evidence:
  - packages/accounting-engine/src/recovery.ts
  - packages/database/prisma/migrations/20261104090000_recovery_planner/migration.sql
  - apps/api/src/recovery/recovery.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/recovery/[planId]/page.tsx
  - packages/accounting-engine/test/recovery.test.ts
  - apps/api/test/recovery.e2e.test.ts
  - apps/web/e2e/recovery-flow.test.mjs
  - docs/RECOVERY_PLANNER.md

### RECOV-003 — Collection acceleration plans

- Module: Financial recovery planner
- Status: **Tested**
- Notes: Chase overdue invoices (up to 90 days late counted as recoverable, customers listed largest first) and shorter terms for new invoices.
- Evidence:
  - packages/accounting-engine/src/recovery.ts
  - packages/database/prisma/migrations/20261104090000_recovery_planner/migration.sql
  - apps/api/src/recovery/recovery.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/recovery/[planId]/page.tsx
  - packages/accounting-engine/test/recovery.test.ts
  - apps/api/test/recovery.e2e.test.ts
  - apps/web/e2e/recovery-flow.test.mjs
  - docs/RECOVERY_PLANNER.md

### RECOV-004 — Expense reduction options

- Module: Financial recovery planner
- Status: **Tested**
- Notes: A 20% cut option for each of the five largest operating expense accounts, from their average monthly spend.
- Evidence:
  - packages/accounting-engine/src/recovery.ts
  - packages/database/prisma/migrations/20261104090000_recovery_planner/migration.sql
  - apps/api/src/recovery/recovery.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/recovery/[planId]/page.tsx
  - packages/accounting-engine/test/recovery.test.ts
  - apps/api/test/recovery.e2e.test.ts
  - apps/web/e2e/recovery-flow.test.mjs
  - docs/RECOVERY_PLANNER.md

### RECOV-005 — Supplier renegotiation opportunities

- Module: Financial recovery planner
- Status: **Tested**
- Notes: Longer payment terms and 3% lower prices from suppliers, listing suppliers by average monthly bills.
- Evidence:
  - packages/accounting-engine/src/recovery.ts
  - packages/database/prisma/migrations/20261104090000_recovery_planner/migration.sql
  - apps/api/src/recovery/recovery.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/recovery/[planId]/page.tsx
  - packages/accounting-engine/test/recovery.test.ts
  - apps/api/test/recovery.e2e.test.ts
  - apps/web/e2e/recovery-flow.test.mjs
  - docs/RECOVERY_PLANNER.md

### RECOV-006 — Financing scenarios

- Module: Financial recovery planner
- Status: **Tested**
- Notes: Working capital loan sized until its repayments no longer open a gap, and new capital from owners or investors.
- Evidence:
  - packages/accounting-engine/src/recovery.ts
  - packages/database/prisma/migrations/20261104090000_recovery_planner/migration.sql
  - apps/api/src/recovery/recovery.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/recovery/[planId]/page.tsx
  - packages/accounting-engine/test/recovery.test.ts
  - apps/api/test/recovery.e2e.test.ts
  - apps/web/e2e/recovery-flow.test.mjs
  - docs/RECOVERY_PLANNER.md

### RECOV-007 — Revenue improvement opportunities

- Module: Financial recovery planner
- Status: **Tested**
- Notes: Price rise option (+5% with 2% less volume).
- Evidence:
  - packages/accounting-engine/src/recovery.ts
  - packages/database/prisma/migrations/20261104090000_recovery_planner/migration.sql
  - apps/api/src/recovery/recovery.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/recovery/[planId]/page.tsx
  - packages/accounting-engine/test/recovery.test.ts
  - apps/api/test/recovery.e2e.test.ts
  - apps/web/e2e/recovery-flow.test.mjs
  - docs/RECOVERY_PLANNER.md

### RECOV-008 — Operational restructuring simulations

- Module: Financial recovery planner
- Status: **Tested**
- Notes: Payroll cost reduction modelled only, marked as a decision for the owners, never a recommendation to let anyone go.
- Evidence:
  - packages/accounting-engine/src/recovery.ts
  - packages/database/prisma/migrations/20261104090000_recovery_planner/migration.sql
  - apps/api/src/recovery/recovery.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/recovery/[planId]/page.tsx
  - packages/accounting-engine/test/recovery.test.ts
  - apps/api/test/recovery.e2e.test.ts
  - apps/web/e2e/recovery-flow.test.mjs
  - docs/RECOVERY_PLANNER.md

### RECOV-009 — Liquidity recovery forecasts

- Module: Financial recovery planner
- Status: **Tested**
- Notes: Liquidity forecast of the plan against no action: runway, lowest cash, cash still to raise, month-end cash chart.
- Evidence:
  - packages/accounting-engine/src/recovery.ts
  - packages/database/prisma/migrations/20261104090000_recovery_planner/migration.sql
  - apps/api/src/recovery/recovery.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/recovery/[planId]/page.tsx
  - packages/accounting-engine/test/recovery.test.ts
  - apps/api/test/recovery.e2e.test.ts
  - apps/web/e2e/recovery-flow.test.mjs
  - docs/RECOVERY_PLANNER.md

### RECOV-010 — Display projected outcomes and risks

- Module: Financial recovery planner
- Status: **Tested**
- Notes: Each option and the plan show measured outcomes (lowest cash, cash at the end, net profit, whether cash runs out) and risks.
- Evidence:
  - packages/accounting-engine/src/recovery.ts
  - packages/database/prisma/migrations/20261104090000_recovery_planner/migration.sql
  - apps/api/src/recovery/recovery.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/recovery/[planId]/page.tsx
  - packages/accounting-engine/test/recovery.test.ts
  - apps/api/test/recovery.e2e.test.ts
  - apps/web/e2e/recovery-flow.test.mjs
  - docs/RECOVERY_PLANNER.md

### RECOV-011 — Do not execute layoffs, borrowing, contract changes or financial transfers autonomously

- Module: Financial recovery planner
- Status: **Tested**
- Notes: The planner only records decisions: tests check no journal, payment or loan is created; options needing a decision are marked.
- Evidence:
  - packages/accounting-engine/src/recovery.ts
  - packages/database/prisma/migrations/20261104090000_recovery_planner/migration.sql
  - apps/api/src/recovery/recovery.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/recovery/[planId]/page.tsx
  - packages/accounting-engine/test/recovery.test.ts
  - apps/api/test/recovery.e2e.test.ts
  - apps/web/e2e/recovery-flow.test.mjs
  - docs/RECOVERY_PLANNER.md

### BENCH-001 — Design an opt-in benchmarking network

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Opt-in network: owners and admins join with recorded, versioned consent and can withdraw at any time.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-002 — Allow organizations to compare selected metrics against aggregated peer groups

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Give-to-get: each shared metric is compared with the median and quartiles of peer groups (industry, size, country), narrowest group with enough participants first.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-003 — Gross margin

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Gross margin over 12 months.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-004 — Net margin

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Net margin over 12 months.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-005 — Revenue growth

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Revenue growth, 12 months against the 12 before.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-006 — Operating expense ratio

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Operating expense ratio over 12 months.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-007 — Days sales outstanding

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Days sales outstanding (3-month basis).
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-008 — Days payable outstanding

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Days payables outstanding (3-month basis).
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-009 — Working capital efficiency

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Working capital efficiency: days of sales tied up in receivables + inventory − payables.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-010 — Revenue per employee

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Revenue per employee from payroll headcount (or entered); compared only within the same currency.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-011 — Project profitability

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Project profitability: profit before overheads of tagged projects ÷ their revenue.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-012 — Cash conversion cycle

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Cash conversion cycle: DSO + days inventory − DPO.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-013 — Explicit customer consent

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Explicit consent statement must be ticked; who agreed, when and the consent version are stored and audited.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-014 — Aggregation thresholds

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Median only with 5+ other participants; quartiles only with 10+.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-015 — Suppression of small groups

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Groups below the threshold are suppressed and the next broader group is tried; counts are shown only as bands.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-016 — No exposure of competitor-specific financial data

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Only aggregates over other participants are returned; no organisation id in the pool; tests check no single value is returned.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-017 — Privacy-preserving processing

- Module: Privacy-preserving financial benchmarking
- Status: **Implementing**
- Notes: Rounded ratios under random keys in a system-only pool; no differential-privacy noise yet (differencing over time is a documented limitation).
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-018 — Tenant isolation

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Participation is a tenant table with forced RLS; the pool has a system-only RLS policy, tested against tenant reads and writes.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-019 — Transparent benchmark methodology

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Formulas, thresholds, peer-group order and privacy rules are shown on the page and in docs/BENCHMARKING.md.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-020 — Do not fabricate benchmark datasets

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: The live pool holds only real participants; nothing is invented. Demo organisations never reach it.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### BENCH-021 — Use clearly labeled synthetic data for demonstrations

- Module: Privacy-preserving financial benchmarking
- Status: **Tested**
- Notes: Synthetic peers (seed:benchmark-peers, refused in production) are flagged is_synthetic, compared only with demo organisations and labelled on the page.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### I18N-002 — Multi-currency accounting

- Module: Internationalization
- Status: **Implementing**
- Notes: Transaction currency + rate per line, functional currency per org. Rate tables, revaluation and multi-currency reporting are not done.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › converts foreign-currency lines

### I18N-003 — Regional number formats

- Module: Internationalization
- Status: **Implementing**
- Notes: Amounts use Intl.NumberFormat on exact decimal strings (en-IN style grouping for INR). A per-user locale setting is not built.
- Evidence:
  - apps/web/src

### I18N-004 — Regional date formats

- Module: Internationalization
- Status: **Implementing**
- Notes: Printed invoices use the template's date style (02 Nov 2026, Nov 2, 2026 or 2026-11-02). The app's own screens still use one format.
- Evidence:
  - packages/accounting-engine/src/invoice-templates.ts
  - packages/accounting-engine/test/invoice-templates.test.ts
  - apps/api/src/invoice-templates/invoice-templates.service.ts
  - apps/api/test/invoice-templates.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/settings/invoice-templates
  - apps/web/src/app/orgs/[orgId]/print/[documentId]/page.tsx
  - apps/web/e2e/invoice-templates-flow.test.mjs
  - packages/database/prisma/migrations/20261103110000_invoice_templates/migration.sql
  - docs/INVOICE_TEMPLATES.md

### I18N-006 — Country-specific invoice formats

- Module: Internationalization
- Status: **Tested**
- Notes: Invoice and credit note layouts from country presets: India GST tax invoice (CGST Rule 46 checks), UAE VAT (bilingual title), UK VAT, US, Singapore GST, Australia GST, EU VAT (Article 226 checks) and generic. Each preset sets the title, tax number label, columns, date and number style, paper size and the rules the designer warns about. Not built: Saudi ZATCA QR, Arabic right-to-left body text, legal review of each preset.
- Evidence:
  - packages/accounting-engine/src/invoice-templates.ts
  - packages/accounting-engine/test/invoice-templates.test.ts
  - apps/api/src/invoice-templates/invoice-templates.service.ts
  - apps/api/test/invoice-templates.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/settings/invoice-templates
  - apps/web/src/app/orgs/[orgId]/print/[documentId]/page.tsx
  - apps/web/e2e/invoice-templates-flow.test.mjs
  - packages/database/prisma/migrations/20261103110000_invoice_templates/migration.sql
  - docs/INVOICE_TEMPLATES.md

### I18N-009 — Regional document templates

- Module: Internationalization
- Status: **Tested**
- Notes: Templates per organisation: five themes, eight palettes plus custom colours, fonts, editable and reorderable sections and columns, logos, and HTML templates with safe placeholders. Covers invoices and credit notes; quotes, statements, receipts and payslips do not use templates yet.
- Evidence:
  - packages/accounting-engine/src/invoice-templates.ts
  - packages/accounting-engine/test/invoice-templates.test.ts
  - apps/api/src/invoice-templates/invoice-templates.service.ts
  - apps/api/test/invoice-templates.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/settings/invoice-templates
  - apps/web/src/app/orgs/[orgId]/print/[documentId]/page.tsx
  - apps/web/e2e/invoice-templates-flow.test.mjs
  - packages/database/prisma/migrations/20261103110000_invoice_templates/migration.sql
  - docs/INVOICE_TEMPLATES.md

### I18N-010 — Configurable fiscal years

- Module: Internationalization
- Status: **Implemented**
- Evidence:
  - packages/accounting-engine/test/periods.test.ts
  - apps/web/src

### INTG-032 — Email providers

- Module: Integration marketplace
- Status: **Integration pending**
- Notes: Each organisation sets up its own SMTP server (any provider offering SMTP) in Settings → Integrations, with a test that signs in and sends an email. Tested against a local SMTP server; waiting on a check with a real provider.
- Evidence:
  - apps/api/src/integrations/integrations.service.ts
  - apps/api/src/integrations/secret-box.ts
  - packages/database/prisma/migrations/20261103210000_org_integrations/migration.sql
  - apps/web/src/app/orgs/[orgId]/settings/integrations/page.tsx
  - apps/api/test/integrations.e2e.test.ts
  - apps/web/e2e/integrations-flow.test.mjs
  - docs/INTEGRATIONS.md

### INTG-034 — Claude

- Module: Integration marketplace
- Status: **Integration pending**
- Notes: Each organisation adds its own Claude API key and model in Settings → Integrations; all four AI agents use it. Tested through the official SDK against a local stand-in; waiting on a check with a live key.
- Evidence:
  - apps/api/src/integrations/integrations.service.ts
  - apps/api/src/integrations/secret-box.ts
  - packages/database/prisma/migrations/20261103210000_org_integrations/migration.sql
  - apps/web/src/app/orgs/[orgId]/settings/integrations/page.tsx
  - apps/api/test/integrations.e2e.test.ts
  - apps/web/e2e/integrations-flow.test.mjs
  - docs/INTEGRATIONS.md

### INTG-040 — Connection status

- Module: Integration marketplace
- Status: **Tested**
- Notes: For AI and email: which settings are in use (the organisation’s, the server’s fallback, or none) and the last test result with its message, time and who ran it.
- Evidence:
  - apps/api/src/integrations/integrations.service.ts
  - apps/api/src/integrations/secret-box.ts
  - packages/database/prisma/migrations/20261103210000_org_integrations/migration.sql
  - apps/web/src/app/orgs/[orgId]/settings/integrations/page.tsx
  - apps/api/test/integrations.e2e.test.ts
  - apps/web/e2e/integrations-flow.test.mjs
  - docs/INTEGRATIONS.md

### INTG-047 — Audit logs

- Module: Integration marketplace
- Status: **Tested**
- Notes: Creating, changing, testing and removing an integration are audited; secrets are never written to the audit trail, only whether they changed and their last four characters.
- Evidence:
  - apps/api/src/integrations/integrations.service.ts
  - apps/api/src/integrations/secret-box.ts
  - packages/database/prisma/migrations/20261103210000_org_integrations/migration.sql
  - apps/web/src/app/orgs/[orgId]/settings/integrations/page.tsx
  - apps/api/test/integrations.e2e.test.ts
  - apps/web/e2e/integrations-flow.test.mjs
  - docs/INTEGRATIONS.md

### INTG-048 — Disconnect controls

- Module: Integration marketplace
- Status: **Tested**
- Notes: Each integration can be switched off (kept) or removed; the features then fall back to the server’s settings or say they are not set up.
- Evidence:
  - apps/api/src/integrations/integrations.service.ts
  - apps/api/src/integrations/secret-box.ts
  - packages/database/prisma/migrations/20261103210000_org_integrations/migration.sql
  - apps/web/src/app/orgs/[orgId]/settings/integrations/page.tsx
  - apps/api/test/integrations.e2e.test.ts
  - apps/web/e2e/integrations-flow.test.mjs
  - docs/INTEGRATIONS.md

### INTG-050 — Never claim an integration is live merely because its interface exists

- Module: Integration marketplace
- Status: **Tested**
- Notes: The page shows "Not tested", "Working" or "Failed" from a real test, never "connected" just because settings were saved; the registry keeps Claude and email at Integration pending until checked with live credentials.
- Evidence:
  - apps/api/src/integrations/integrations.service.ts
  - apps/api/src/integrations/secret-box.ts
  - packages/database/prisma/migrations/20261103210000_org_integrations/migration.sql
  - apps/web/src/app/orgs/[orgId]/settings/integrations/page.tsx
  - apps/api/test/integrations.e2e.test.ts
  - apps/web/e2e/integrations-flow.test.mjs
  - docs/INTEGRATIONS.md

### SEC-001 — Multi-tenant isolation

- Module: Security and enterprise governance
- Status: **Tested**
- Notes: Application-level scoping, composite foreign keys, and PostgreSQL row-level security (forced, transaction-local tenant settings) on every tenant table.
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › tenant isolation
  - Composite (id, org_id) foreign keys in schema
  - packages/database/prisma/migrations/20261031220000_row_level_security
  - apps/api/test/row-level-security.e2e.test.ts

### SEC-002 — Organization-level access controls

- Module: Security and enterprise governance
- Status: **Tested**
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › roles and permissions

### SEC-003 — Role-based access control

- Module: Security and enterprise governance
- Status: **Tested**
- Notes: Fixed roles: OWNER, ADMIN, ACCOUNTANT, APPROVER, VIEWER. Custom roles not done.
- Evidence:
  - packages/security/test/security.test.ts
  - apps/api/test/auth-tenancy.e2e.test.ts › roles and permissions

### SEC-008 — Session management

- Module: Security and enterprise governance
- Status: **Tested**
- Notes: Server-side sessions: 15-minute access token naming the session, rotating refresh token (hash stored), reuse detection with a 30 s grace window, 30-day hard and 7-day idle expiry, revoke one / all others, password change signs out other devices. Both tokens are httpOnly cookies in the web app.
- Evidence:
  - apps/api/src/auth/sessions.service.ts
  - apps/api/test/sessions-security.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/account
  - apps/web/e2e/security-flow.test.mjs

### SEC-009 — Device management

- Module: Security and enterprise governance
- Status: **Implementing**
- Notes: A device is a signed-in session: listed with browser, address and last activity, and can be signed out. No trusted-device registration, device binding or new-device alerts.
- Evidence:
  - apps/web/src/app/orgs/[orgId]/account
  - apps/web/e2e/security-flow.test.mjs

### SEC-012 — Secrets management

- Module: Security and enterprise governance
- Status: **Implementing**
- Notes: Server secrets come from environment variables, validated at startup. Integration secrets an organisation enters in the app are encrypted with AES-256-GCM (key from INTEGRATIONS_ENCRYPTION_KEY or derived from JWT_SECRET), never returned and never audited. No external secrets manager (Vault, KMS) yet.
- Evidence:
  - .env.example
  - apps/api/src/config.ts
  - apps/api/src/integrations/secret-box.ts

### SEC-014 — Audit logging

- Module: Security and enterprise governance
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › audit trail
  - apps/web/src/app/orgs/[orgId]/audit
  - apps/web/e2e/ledger-flow.test.mjs

### SEC-015 — API authentication

- Module: Security and enterprise governance
- Status: **Tested**
- Notes: Email + password (scrypt), HS256 JWT access tokens bound to a server-side session, rotating refresh tokens. Sign-in lockout per email after 5 failures for 15 minutes.
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › authentication
  - apps/api/test/sessions-security.e2e.test.ts › refresh tokens

### SEC-016 — Rate limiting

- Module: Security and enterprise governance
- Status: **Tested**
- Notes: Per-IP limit on sign-in/register/refresh and per-user limit on the API (429 with Retry-After). Counters are in memory per API process (not shared across instances); lockout counters are in PostgreSQL.
- Evidence:
  - apps/api/src/auth/rate-limit.ts
  - apps/api/src/auth/login-throttle.service.ts
  - apps/api/test/sessions-security.e2e.test.ts › rate limiting
  - apps/api/test/sessions-security.e2e.test.ts › sign-in lockout

### SEC-017 — Input validation

- Module: Security and enterprise governance
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › rejects unbalanced, malformed and header-account entries
  - zod schemas on every endpoint

### SEC-032 — AI action logging

- Module: Security and enterprise governance
- Status: **Tested**
- Notes: Copilot: every question and answer is in the audit trail (who, outcome, tools used, model that answered, tokens); answers keep the exact exchange with the model.
- Evidence:
  - apps/api/src/copilot
  - apps/api/test/copilot.e2e.test.ts
  - apps/web/e2e/copilot-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/copilot
  - packages/database/prisma/migrations/20261102090000_ai_copilot

### SEC-033 — AI usage controls

- Module: Security and enterprise governance
- Status: **Tested**
- Notes: Copilot: off per organisation until an owner or admin turns it on (copilot.use to ask, org.manage to switch), at most 60 questions per member per hour, a step limit and a time limit per answer.
- Evidence:
  - apps/api/src/copilot
  - apps/api/test/copilot.e2e.test.ts
  - apps/web/e2e/copilot-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/copilot
  - packages/database/prisma/migrations/20261102090000_ai_copilot

### SEC-035 — Cross-tenant data leakage tests

- Module: Security and enterprise governance
- Status: **Tested**
- Notes: Covers API probes (404) and database-level checks that bypass application filters. No AI features exist yet, so AI-specific leakage tests are not applicable.
- Evidence:
  - apps/api/test/row-level-security.e2e.test.ts
  - apps/api/test/auth-tenancy.e2e.test.ts › tenant isolation

### SEC-036 — Human approval gates

- Module: Security and enterprise governance
- Status: **Implementing**
- Notes: Human approval gate for posting covered sales and purchase documents. Not yet applied to journals, payments or AI actions (no AI actions exist).
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts

### UX-002 — Create organization

- Module: User experience and onboarding
- Status: **Tested**
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › organization onboarding
  - apps/web/src/app/onboarding
  - apps/web/e2e/ledger-flow.test.mjs

### UX-007 — Configure fiscal year

- Module: User experience and onboarding
- Status: **Tested**
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › organization onboarding
  - apps/web/src/app/onboarding
  - apps/web/e2e/ledger-flow.test.mjs

### UX-008 — Configure currency

- Module: User experience and onboarding
- Status: **Tested**
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › organization onboarding
  - apps/web/src/app/onboarding
  - apps/web/e2e/ledger-flow.test.mjs

### UX-015 — Configure team roles

- Module: User experience and onboarding
- Status: **Tested**
- Notes: Invite links (token hash stored, 7 days, only the invited email can accept, one use), new link and revoke, role changes within what the actor may grant, removing members, and at least one owner kept (service and trigger). Talk2Tax does not send email; the inviter shares the link.
- Evidence:
  - apps/api/src/organizations/invitations.service.ts
  - apps/api/test/invitations.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/members
  - apps/web/src/app/invite
  - apps/web/e2e/members-flow.test.mjs

### UX-016 — Configure approval policies

- Module: User experience and onboarding
- Status: **Tested**
- Notes: One rule per document type: on/off, minimum total, separate approver.
- Evidence:
  - apps/web/src/app/orgs/[orgId]/settings/approvals
  - apps/web/e2e/approvals-flow.test.mjs › an owner sets an approval rule

### ADMIN-004 — User management

- Module: Platform super admin
- Status: **Tested**
- Notes: Invite links (token hash stored, 7 days, only the invited email can accept, one use), new link and revoke, role changes within what the actor may grant, removing members, and at least one owner kept (service and trigger). Talk2Tax does not send email; the inviter shares the link.
- Evidence:
  - apps/api/src/organizations/invitations.service.ts
  - apps/api/test/invitations.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/members
  - apps/web/src/app/invite
  - apps/web/e2e/members-flow.test.mjs

### MOB-001 — Create a responsive web application first

- Module: Mobile experience
- Status: **Implementing**
- Notes: Layouts are responsive and checked at phone width; no dedicated mobile navigation pattern yet.
- Evidence:
  - apps/web/src

### MOB-007 — Approval management

- Module: Mobile experience
- Status: **Implementing**
- Notes: Approvals work in the responsive web app at phone width; no mobile app.
- Evidence:
  - apps/web/src/components/expenses/claims-list.tsx

### PERF-017 — Financial posting with transactional consistency

- Module: Performance and scalability
- Status: **Tested**
- Notes: Correctness under concurrency is tested; throughput has not been benchmarked.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › idempotency and concurrency

### PERF-018 — No cross-tenant data exposure

- Module: Performance and scalability
- Status: **Tested**
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › tenant isolation

### QA-001 — Build automated testing from the beginning

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - pnpm test runs unit + integration suites
  - .github/workflows/ci.yml

### QA-002 — Unit tests

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - packages/accounting-engine/test/journal.test.ts
  - packages/accounting-engine/test/reports.test.ts
  - packages/accounting-engine/test/money.test.ts
  - packages/accounting-engine/test/periods.test.ts
  - packages/security/test/security.test.ts

### QA-003 — Integration tests

- Module: Testing and quality assurance
- Status: **Tested**
- Notes: Run against a real PostgreSQL database.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts
  - apps/api/test/auth-tenancy.e2e.test.ts

### QA-004 — API tests

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts
  - apps/api/test/auth-tenancy.e2e.test.ts

### QA-005 — End-to-end tests

- Module: Testing and quality assurance
- Status: **Tested**
- Notes: Playwright browser tests drive the real web app against the real API and PostgreSQL in CI.
- Evidence:
  - apps/web/e2e/ledger-flow.test.mjs

### QA-006 — Accounting invariant tests

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - packages/accounting-engine/test/reports.test.ts
  - apps/api/test/ledger.e2e.test.ts

### QA-008 — Multi-currency tests

- Module: Testing and quality assurance
- Status: **Tested**
- Notes: Conversion and precision only; revaluation not built.
- Evidence:
  - packages/accounting-engine/test/journal.test.ts
  - apps/api/test/ledger.e2e.test.ts › converts foreign-currency lines

### QA-009 — Reconciliation tests

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - apps/api/test/banking.e2e.test.ts
  - packages/accounting-engine/test/bank.test.ts

### QA-011 — Financial reporting tests

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - packages/accounting-engine/test/reports.test.ts
  - apps/api/test/ledger.e2e.test.ts › reports

### QA-012 — Permission tests

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › roles and permissions

### QA-013 — Tenant isolation tests

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › tenant isolation

### QA-021 — Every journal balances

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - packages/accounting-engine/test/journal.test.ts
  - apps/api/test/ledger.e2e.test.ts

### QA-022 — Reversals preserve history

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › reverses a posted entry exactly once

### QA-023 — Closed periods reject unauthorized postings

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › period locks

### QA-024 — Currency conversions use the correct rate and precision

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - packages/accounting-engine/test/journal.test.ts
  - packages/accounting-engine/test/money.test.ts

### QA-025 — Trial balance reconciles

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › financial reports

### QA-026 — Financial statements reconcile to the ledger

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › produce a balanced trial balance and statements that tie out

### QA-027 — Duplicate requests do not duplicate postings

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › idempotency and concurrency

### QA-028 — Concurrent operations preserve accounting consistency

- Module: Testing and quality assurance
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › assigns gap-free unique numbers under concurrent posting; allows only one of many concurrent reversals

### QA-031 — Use deterministic test fixtures

- Module: Testing and quality assurance
- Status: **Implementing**
- Notes: The demo seed and test fixtures are deterministic; a shared fixture library for all scenarios is not done.
- Evidence:
  - apps/web/src

### DEMO-013 — Journal entries

- Module: Demonstration data
- Status: **Implementing**
- Notes: One synthetic Indian trading company with ~7 months of journals. The other demo companies and record types are not done.
- Evidence:
  - apps/api/src/seed/seed-demo.ts

### DEMO-021 — Do not imply the figures represent real organizations

- Module: Demonstration data
- Status: **Tested**
- Notes: Demo org is named "(SYNTHETIC DATA)", flagged is_demo, and the seed refuses to run when NODE_ENV=production.
- Evidence:
  - apps/api/src/seed/seed-demo.ts

### INNOV-001 — Connect customers, contracts, invoices, vendors, projects, payments, journal entries and risks in an explainable relationship graph

- Module: Additional differentiating innovations
- Status: **Implemented**
- Notes: Relationship explorer over customers, vendors, invoices, bills, payments, journal entries, accounts, projects, departments, loans, fixed assets and alerts (risks), every connection with a plain-language reason, read live from the books. Contracts are not modelled in the product yet, so they are not in the graph.
- Evidence:
  - apps/api/src/graph/graph.service.ts
  - apps/api/src/graph/graph.controller.ts
  - apps/api/test/graph.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/graph/page.tsx
  - apps/web/e2e/knowledge-graph-flow.test.mjs
  - docs/KNOWLEDGE_GRAPH.md

### INNOV-002 — Maintain a searchable history of approved management decisions, assumptions, financial outcomes and lessons learned

- Module: Additional differentiating innovations
- Status: **Tested**
- Notes: Decisions with context, assumptions and expected outcomes (KPIs with a target and month, compared with the month before the decision and measured from the posted books); search across decisions, assumptions and lessons; review records whether each assumption held, a verdict and lessons, and freezes the measured figures; reviewed and withdrawn decisions are locked by a database trigger. Approved scenarios and recovery plans can be recorded as decisions.
- Evidence:
  - packages/accounting-engine/src/decisions.ts
  - packages/accounting-engine/test/decisions.test.ts
  - packages/database/prisma/migrations/20261105120000_decision_memory/migration.sql
  - apps/api/src/decisions
  - apps/api/test/decisions.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/decisions
  - apps/web/e2e/decision-memory-flow.test.mjs
  - docs/DECISION_MEMORY.md

### INNOV-003 — Allow organizations to define financial policies conversationally

- Module: Additional differentiating innovations
- Status: **Tested**
- Notes: A policy is written in plain words; the AI (Claude, through the AI control guard and the copilot's switch and budget, prompt version recorded) drafts rules and tests from the words and asks about anything unclear, and the person answers to revise the draft. Nothing the AI proposes is saved or runs until a person saves it and someone else approves it. Live drafting waits on a Claude key (scripted model in tests).
- Evidence:
  - packages/accounting-engine/src/policies.ts
  - packages/accounting-engine/test/policies.test.ts
  - packages/database/prisma/migrations/20261105210000_policy_studio/migration.sql
  - apps/api/src/policies
  - apps/api/test/policies.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/governance/policies
  - apps/web/src/components/policies
  - apps/web/e2e/policy-studio-flow.test.mjs
  - docs/POLICY_STUDIO.md

### INNOV-004 — Convert approved policies into testable, version-controlled workflow rules

- Module: Additional differentiating innovations
- Status: **Tested**
- Notes: Each rule is a workflow definition (trigger, conditions, actions to roles or the customer/vendor). Test cases state whether a rule should act on given facts and run on the server, with each condition's actual value; a back-test runs event rules over the last 90 days of real events. Approval needs every test passing and someone other than the last editor (workflows.manage); it creates or versions one workflow per rule and turns off workflows of removed rules. Every version (created, edited, approved, retired) is kept in an immutable table.
- Evidence:
  - packages/accounting-engine/src/policies.ts
  - packages/accounting-engine/test/policies.test.ts
  - packages/database/prisma/migrations/20261105210000_policy_studio/migration.sql
  - apps/api/src/policies
  - apps/api/test/policies.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/governance/policies
  - apps/web/src/components/policies
  - apps/web/e2e/policy-studio-flow.test.mjs
  - docs/POLICY_STUDIO.md

### INNOV-005 — Evaluate financial indicators continuously and provide prioritized alerts

- Module: Additional differentiating innovations
- Status: **Implemented**
- Notes: Nine checks run on demand and automatically when alerts are opened and the last run is over an hour old, ordered by severity. No background schedule or notifications yet.
- Evidence:
  - packages/accounting-engine/src/alerts.ts
  - packages/accounting-engine/test/alerts.test.ts
  - apps/api/src/alerts
  - apps/api/test/alerts.e2e.test.ts
  - apps/web/e2e/alerts-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/alerts

### INNOV-006 — Provide a centralized queue of tasks generated by users, rules and AI agents

- Module: Additional differentiating innovations
- Status: **Implementing**
- Notes: Task queue for people and automations: tasks for a person or a role, due dates, overdue, links to the record, done or cancelled with a note, audit trail. Tasks from AI agents are later work.
- Evidence:
  - apps/api/src/tasks
  - apps/web/src/app/orgs/[orgId]/tasks
  - apps/api/test/workflows.e2e.test.ts
  - apps/web/e2e/automations-flow.test.mjs

### INNOV-007 — Allow users to trace any reported figure to its originating transactions and documents

- Module: Additional differentiating innovations
- Status: **Tested**
- Notes: Trial balance, profit and loss and balance sheet lines open the general ledger for the same dates; each ledger line names the record that created it (document, payment, expense claim, pay run, asset, depreciation, deferral, accrual, loan, close adjustment, intercompany charge or the reversed entry) and links to it and to its connections. P&L lines filtered by department or project are not linked because the ledger is not filtered.
- Evidence:
  - apps/api/src/graph/graph.service.ts
  - apps/api/src/graph/graph.controller.ts
  - apps/api/test/graph.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/graph/page.tsx
  - apps/web/e2e/knowledge-graph-flow.test.mjs
  - docs/KNOWLEDGE_GRAPH.md
  - apps/api/src/reports/reports.service.ts
  - apps/web/src/app/orgs/[orgId]/reports/general-ledger/page.tsx
  - apps/web/src/app/orgs/[orgId]/reports/income-statement/page.tsx
  - apps/web/src/app/orgs/[orgId]/reports/balance-sheet/page.tsx
  - apps/web/src/app/orgs/[orgId]/reports/trial-balance/page.tsx

### INNOV-009 — Compare forecast models against historical outcomes and track accuracy

- Module: Additional differentiating innovations
- Status: **Tested**
- Notes: Eight forecasting methods (last month, 3/6/12-month averages, same month last year, last month plus trend, straight-line trend, exponential smoothing) backtested with a rolling origin over 6, 12 or 18 months on revenue, cost of sales, operating expenses, net income and net cash flow; ranked by WAPE with MAE, bias, within-10% and error by months ahead; saved runs are immutable and their forecasts are measured against the books once each month is over.
- Evidence:
  - packages/accounting-engine/src/forecast-lab.ts
  - packages/accounting-engine/test/forecast-lab.test.ts
  - packages/database/prisma/migrations/20261105150000_forecast_lab/migration.sql
  - apps/api/src/forecast-lab
  - apps/api/test/forecast-lab.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/planning/forecast-lab
  - apps/web/e2e/forecast-lab-flow.test.mjs
  - docs/FORECAST_LAB.md

### INNOV-010 — Simulate liquidity shocks, customer defaults, supplier failures and major operational disruptions

- Module: Additional differentiating innovations
- Status: **Tested**
- Notes: Customer default (write-off of the customer's balance and loss of its share of sales), supplier failure (lost sales until replaced, then a share-weighted cost rise), liquidity shock (frozen cash, withdrawn credit, late payers), operational disruption (lost sales, recovery cost, insurance) and demand collapse, built from the organisation's own customers, suppliers and cash and played through the digital twin; each shock also measured alone; seven standard stress tests ranked worst first; saved simulations re-run on the latest books and can be copied into a twin scenario.
- Evidence:
  - packages/accounting-engine/src/disaster.ts
  - packages/accounting-engine/test/disaster.test.ts
  - packages/database/prisma/migrations/20261105180000_disaster_simulation/migration.sql
  - apps/api/src/disasters
  - apps/api/test/disasters.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/planning/disasters
  - apps/web/e2e/disaster-simulation-flow.test.mjs
  - docs/DISASTER_SIMULATION.md

### INNOV-012 — Generate evidence-based financial recovery scenarios

- Module: Additional differentiating innovations
- Status: **Tested**
- Notes: Covered by the financial recovery planner (docs/RECOVERY_PLANNER.md): recovery options measured on the digital twin from the books (collections, supplier terms, cost cuts, funding, pricing), combined into plans with their cash effect and evidence.
- Evidence:
  - packages/accounting-engine/src/recovery.ts
  - packages/database/prisma/migrations/20261104090000_recovery_planner/migration.sql
  - apps/api/src/recovery/recovery.service.ts
  - apps/web/src/app/orgs/[orgId]/planning/recovery/[planId]/page.tsx
  - packages/accounting-engine/test/recovery.test.ts
  - apps/api/test/recovery.e2e.test.ts
  - apps/web/e2e/recovery-flow.test.mjs
  - docs/RECOVERY_PLANNER.md

### INNOV-015 — Allow users to describe a dashboard in natural language

- Module: Additional differentiating innovations
- Status: **Tested**
- Notes: A dashboard is described in words; the AI (Claude, through the AI control guard and the copilot's switch and budget, prompt version recorded) proposes widgets, says what asked-for data is not available, and asks questions that the person answers to revise the draft. Live drafting waits on a Claude key (scripted model in tests).
- Evidence:
  - packages/accounting-engine/src/dashboards.ts
  - packages/accounting-engine/test/dashboards.test.ts
  - packages/database/prisma/migrations/20261106090000_ai_dashboards/migration.sql
  - apps/api/src/dashboards
  - apps/api/test/dashboards.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/reports/dashboards
  - apps/web/src/components/dashboards
  - apps/web/e2e/dashboards-flow.test.mjs
  - docs/AI_DASHBOARDS.md

### INNOV-016 — Generate a validated dashboard configuration using approved metrics

- Module: Additional differentiating innovations
- Status: **Tested**
- Notes: Configurations (figure, line, bar, table, top customers) may only use 23 approved metrics (the KPIs and main figures of the books); the engine checks every widget (approved metric, units not mixed in a chart, month and count limits) whether the AI or a person built it, and works out every figure from posted month figures. The AI never produces a number. Customer widgets need sales.read.
- Evidence:
  - packages/accounting-engine/src/dashboards.ts
  - packages/accounting-engine/test/dashboards.test.ts
  - packages/database/prisma/migrations/20261106090000_ai_dashboards/migration.sql
  - apps/api/src/dashboards
  - apps/api/test/dashboards.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/reports/dashboards
  - apps/web/src/components/dashboards
  - apps/web/e2e/dashboards-flow.test.mjs
  - docs/AI_DASHBOARDS.md

### INNOV-018 — Compare company performance with properly anonymized, authorized benchmark datasets

- Module: Additional differentiating innovations
- Status: **Tested**
- Notes: Covered by benchmarking (docs/BENCHMARKING.md): opt-in with recorded consent, an anonymous pool with no organisation id, medians only with 5+ peers and quartiles with 10+, each metric's formula shown for explanation.
- Evidence:
  - packages/accounting-engine/src/benchmark.ts
  - packages/database/prisma/migrations/20261105090000_benchmarking/migration.sql
  - apps/api/src/benchmarking/benchmarking.service.ts
  - apps/web/src/app/orgs/[orgId]/benchmarking/page.tsx
  - packages/accounting-engine/test/benchmark.test.ts
  - apps/api/test/benchmarking.e2e.test.ts
  - apps/web/e2e/benchmarking-flow.test.mjs
  - docs/BENCHMARKING.md

### NAV-001 — Create a premium sidebar and global navigation system

- Module: Navigation structure
- Status: **Implementing**
- Notes: Sidebar and org switcher exist for the M1 modules; global search and command palette are not built.
- Evidence:
  - apps/web/src

### NAV-002 — Overview

- Module: Navigation structure
- Status: **Implemented**
- Evidence:
  - apps/web/src

### NAV-004 — AI Finance Copilot

- Module: Navigation structure
- Status: **Integration pending**
- Notes: Copilot screen with saved conversations; answers come from read-only tools over the books (P&L, balance sheet, trial balance, ageing, KPIs, management report, cash-flow forecast, budget vs actual, alerts, compliance calendar) and list the reports used. Runs on Anthropic's Claude API through the official SDK; tested end to end against a local stand-in for the API. Not yet run against the live API: waiting for ANTHROPIC_API_KEY.
- Evidence:
  - apps/api/src/copilot
  - apps/api/test/copilot.e2e.test.ts
  - apps/web/e2e/copilot-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/copilot
  - packages/database/prisma/migrations/20261102090000_ai_copilot

### NAV-005 — Accounting

- Module: Navigation structure
- Status: **Implemented**
- Evidence:
  - apps/web/src

### NAV-006 — General Ledger

- Module: Navigation structure
- Status: **Implemented**
- Evidence:
  - apps/web/src

### NAV-010 — Reconciliation

- Module: Navigation structure
- Status: **Implemented**
- Evidence:
  - apps/web/src/components/shell.tsx
  - apps/web/src/components/banking

### NAV-026 — Fixed Assets

- Module: Navigation structure
- Status: **Implemented**
- Notes: Accounting → Fixed assets: register, add or change an asset, asset detail with schedule and disposal, depreciation runs.
- Evidence:
  - apps/web/src/components/shell.tsx
  - apps/web/src/app/orgs/[orgId]/fixed-assets

### NAV-029 — Reports

- Module: Navigation structure
- Status: **Implemented**
- Evidence:
  - apps/web/src

### NAV-033 — Audit

- Module: Navigation structure
- Status: **Implemented**
- Evidence:
  - apps/web/src

### NAV-036 — Automation Studio

- Module: Navigation structure
- Status: **Implementing**
- Notes: Automations list, builder (events, schedules, dates), test (emails go to the tester only), run log with each email and webhook attempt, versions and webhook signing secret for owners and admins.
- Evidence:
  - apps/web/e2e/automations-flow.test.mjs
  - apps/web/e2e/automations-schedule-email.test.mjs
  - apps/web/src/app/orgs/[orgId]/automations

### NAV-039 — Integrations

- Module: Navigation structure
- Status: **Tested**
- Notes: Governance → Integrations, for owners and admins (org.manage).
- Evidence:
  - apps/api/src/integrations/integrations.service.ts
  - apps/api/src/integrations/secret-box.ts
  - packages/database/prisma/migrations/20261103210000_org_integrations/migration.sql
  - apps/web/src/app/orgs/[orgId]/settings/integrations/page.tsx
  - apps/api/test/integrations.e2e.test.ts
  - apps/web/e2e/integrations-flow.test.mjs
  - docs/INTEGRATIONS.md

### NAV-042 — User Management

- Module: Navigation structure
- Status: **Tested**
- Notes: Invite links (token hash stored, 7 days, only the invited email can accept, one use), new link and revoke, role changes within what the actor may grant, removing members, and at least one owner kept (service and trigger). Talk2Tax does not send email; the inviter shares the link.
- Evidence:
  - apps/api/src/organizations/invitations.service.ts
  - apps/api/test/invitations.e2e.test.ts
  - apps/web/src/app/orgs/[orgId]/members
  - apps/web/src/app/invite
  - apps/web/e2e/members-flow.test.mjs

### NAV-046 — Use nested navigation and progressive disclosure

- Module: Navigation structure
- Status: **Implemented**
- Evidence:
  - apps/web/src

### NAV-047 — Do not overwhelm users by showing all modules simultaneously

- Module: Navigation structure
- Status: **Implemented**
- Notes: Sidebar only shows modules that exist today.
- Evidence:
  - apps/web/src

### DS-014 — Approval dialogs

- Module: Design system
- Status: **Implemented**
- Evidence:
  - apps/web/src/components/approvals/approval-card.tsx

### RULE-001 — Do not create fake functional buttons

- Module: Absolute quality rules
- Status: **Implemented**
- Notes: Every button in the web app calls a working API; screens for unbuilt modules are not shown.
- Evidence:
  - apps/web/src

### RULE-002 — Do not create disconnected dashboards

- Module: Absolute quality rules
- Status: **Implemented**
- Notes: The dashboard reads GET /reports/dashboard, computed from posted journals.
- Evidence:
  - apps/web/src

### RULE-003 — Do not substitute static cards for implemented business logic

- Module: Absolute quality rules
- Status: **Implemented**
- Evidence:
  - apps/web/src

### RULE-005 — Do not claim AI functionality when only a static response exists

- Module: Absolute quality rules
- Status: **Tested**
- Notes: Without an API key the copilot says it is not set up and sends nothing; it never shows canned answers. Tests use a scripted stand-in model that is never reachable from the app.
- Evidence:
  - apps/api/src/copilot
  - apps/api/test/copilot.e2e.test.ts
  - apps/web/e2e/copilot-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/copilot
  - packages/database/prisma/migrations/20261102090000_ai_copilot

### RULE-009 — Do not store secrets in source code

- Module: Absolute quality rules
- Status: **Tested**
- Evidence:
  - .env.example
  - .gitignore

### RULE-010 — Do not bypass tenant permissions

- Module: Absolute quality rules
- Status: **Tested**
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts

### RULE-011 — Do not permit unauthorized AI financial actions

- Module: Absolute quality rules
- Status: **Tested**
- Notes: The copilot has read-only tools only; a call to any other tool is refused and reported back to the model.
- Evidence:
  - apps/api/src/copilot
  - apps/api/test/copilot.e2e.test.ts
  - apps/web/e2e/copilot-flow.test.mjs
  - apps/web/src/app/orgs/[orgId]/copilot
  - packages/database/prisma/migrations/20261102090000_ai_copilot

### RULE-012 — Do not use floating-point arithmetic for financial postings

- Module: Absolute quality rules
- Status: **Tested**
- Evidence:
  - packages/accounting-engine/test/money.test.ts

### RULE-013 — Do not modify historical posted transactions silently

- Module: Absolute quality rules
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts

### RULE-014 — Do not expose financial information across tenants

- Module: Absolute quality rules
- Status: **Tested**
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts

### RULE-015 — Do not skip tests for critical accounting functions

- Module: Absolute quality rules
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts
  - packages/accounting-engine/test/journal.test.ts

### RULE-016 — Do not conceal incomplete features

- Module: Absolute quality rules
- Status: **Tested**
- Evidence:
  - docs/FEATURE_STATUS.md
  - docs/KNOWN_LIMITATIONS.md

