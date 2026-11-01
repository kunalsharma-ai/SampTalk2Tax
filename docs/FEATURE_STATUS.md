# Feature status

_Generated. Source of truth: `features/status.json` (status + evidence) merged into `features/registry.json`._

A feature counts as **Implemented** only when its business logic, persistence, API **and UI** work. Backend-complete features without UI are reported as **Implementing** with evidence, never as Implemented.

## Summary

| Status | Count |
|---|---|
| Not started | 1145 |
| Designed | 0 |
| Implementing | 42 |
| Implemented | 28 |
| Tested | 128 |
| Integration pending | 0 |
| External approval required | 0 |
| Blocked | 0 |
| Production ready | 0 |
| **Total** | **1343** |

## By module

| Module | Milestone | Entries | Not started | In progress or later |
|---|---|---|---|---|
| Competitive benchmarking | M0 | 49 | 49 | 0 |
| General ledger and accounting engine | M1 | 44 | 16 | 28 |
| Accounts receivable | M2 | 43 | 33 | 10 |
| Accounts payable | M2 | 36 | 25 | 11 |
| Banking and reconciliation | M2 | 24 | 9 | 15 |
| Global taxation engine | M3 | 54 | 32 | 22 |
| Payroll and workforce finance | M3 | 34 | 20 | 14 |
| Procurement and spend management | M2 | 30 | 30 | 0 |
| Expense management | M2 | 27 | 19 | 8 |
| Treasury management | M6 | 28 | 28 | 0 |
| Financial planning and analysis | M4 | 35 | 35 | 0 |
| Financial digital twin | M7 | 28 | 28 | 0 |
| AI Virtual CFO | M7 | 35 | 35 | 0 |
| Multi-agent AI finance workforce | M5 | 60 | 60 | 0 |
| Autonomous financial workflows | M5 | 22 | 21 | 1 |
| Enterprise financial management | M6 | 29 | 29 | 0 |
| Inventory, manufacturing and service finance | M6 | 21 | 21 | 0 |
| Project financial management | M6 | 33 | 33 | 0 |
| CRM and finance integration | M6 | 13 | 13 | 0 |
| Financial fraud and risk intelligence | M4 | 19 | 19 | 0 |
| Continuous audit and governance | M6 | 30 | 24 | 6 |
| Document intelligence | M2 | 27 | 22 | 5 |
| Advanced financial reporting | M6 | 41 | 41 | 0 |
| Dashboard design | M1 | 68 | 58 | 10 |
| Executive financial command center | M4 | 38 | 38 | 0 |
| AI financial war room | M7 | 17 | 17 | 0 |
| Revenue leakage and profit optimization | M4 | 15 | 15 | 0 |
| Financial recovery planner | M7 | 11 | 11 | 0 |
| Privacy-preserving financial benchmarking | M7 | 21 | 21 | 0 |
| Internationalization | M8 | 16 | 13 | 3 |
| Integration marketplace | M6 | 50 | 50 | 0 |
| Security and enterprise governance | M1 | 38 | 26 | 12 |
| User experience and onboarding | M1 | 22 | 17 | 5 |
| Accounting data migration | M6 | 20 | 20 | 0 |
| Subscription and monetization engine | M9 | 32 | 32 | 0 |
| Platform super admin | M9 | 22 | 21 | 1 |
| Mobile experience | M8 | 16 | 14 | 2 |
| Performance and scalability | M9 | 21 | 19 | 2 |
| Testing and quality assurance | M1 | 31 | 11 | 20 |
| Demonstration data | M1 | 21 | 19 | 2 |
| Additional differentiating innovations | M7 | 18 | 18 | 0 |
| Navigation structure | M1 | 48 | 38 | 10 |
| Design system | M1 | 36 | 35 | 1 |
| Absolute quality rules | All | 20 | 10 | 10 |

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

### GL-030 — Financial dimensions

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Journal lines accept free-form dimension key/values (stored as JSON). Dimension masters (cost centers, departments, etc.), validation and reporting by dimension are not done.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts

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
- Notes: Invoices with tenant-configured tax rates. Not a statutory e-invoice format; no PDF or emailing yet.
- Evidence:
  - apps/api/test/sales-purchases.e2e.test.ts › invoices
  - packages/accounting-engine/test/documents.test.ts
  - apps/web/e2e/sales-flow.test.mjs

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

### WFLOW-006 — Approval workflows

- Module: Autonomous financial workflows
- Status: **Implementing**
- Notes: Single-step approval of sales and purchase drafts by amount. No multi-level chains, escalations or approvals for other record types yet.
- Evidence:
  - apps/api/test/attachments-approvals.e2e.test.ts › approvals
  - apps/web/e2e/approvals-flow.test.mjs

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

### I18N-010 — Configurable fiscal years

- Module: Internationalization
- Status: **Implemented**
- Evidence:
  - packages/accounting-engine/test/periods.test.ts
  - apps/web/src

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
- Notes: Secrets come from environment variables and are validated at startup; no secrets in code. A secrets manager integration is not done.
- Evidence:
  - .env.example
  - apps/api/src/config.ts

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

