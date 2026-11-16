# Feature status

_Generated. Source of truth: `features/status.json` (status + evidence) merged into `features/registry.json`._

A feature counts as **Implemented** only when its business logic, persistence, API **and UI** work. Backend-complete features without UI are reported as **Implementing** with evidence, never as Implemented.

## Summary

| Status | Count |
|---|---|
| Not started | 1226 |
| Designed | 0 |
| Implementing | 14 |
| Implemented | 25 |
| Tested | 78 |
| Integration pending | 0 |
| External approval required | 0 |
| Blocked | 0 |
| Production ready | 0 |
| **Total** | **1343** |

## By module

| Module | Milestone | Entries | Not started | In progress or later |
|---|---|---|---|---|
| Competitive benchmarking | M0 | 49 | 49 | 0 |
| General ledger and accounting engine | M1 | 44 | 17 | 27 |
| Accounts receivable | M2 | 43 | 33 | 10 |
| Accounts payable | M2 | 36 | 27 | 9 |
| Banking and reconciliation | M2 | 24 | 24 | 0 |
| Global taxation engine | M3 | 54 | 53 | 1 |
| Payroll and workforce finance | M3 | 34 | 34 | 0 |
| Procurement and spend management | M2 | 30 | 30 | 0 |
| Expense management | M2 | 27 | 27 | 0 |
| Treasury management | M6 | 28 | 28 | 0 |
| Financial planning and analysis | M4 | 35 | 35 | 0 |
| Financial digital twin | M7 | 28 | 28 | 0 |
| AI Virtual CFO | M7 | 35 | 35 | 0 |
| Multi-agent AI finance workforce | M5 | 60 | 60 | 0 |
| Autonomous financial workflows | M5 | 22 | 22 | 0 |
| Enterprise financial management | M6 | 29 | 29 | 0 |
| Inventory, manufacturing and service finance | M6 | 21 | 21 | 0 |
| Project financial management | M6 | 33 | 33 | 0 |
| CRM and finance integration | M6 | 13 | 13 | 0 |
| Financial fraud and risk intelligence | M4 | 19 | 19 | 0 |
| Continuous audit and governance | M6 | 30 | 28 | 2 |
| Document intelligence | M2 | 27 | 27 | 0 |
| Advanced financial reporting | M6 | 41 | 41 | 0 |
| Dashboard design | M1 | 68 | 58 | 10 |
| Executive financial command center | M4 | 38 | 38 | 0 |
| AI financial war room | M7 | 17 | 17 | 0 |
| Revenue leakage and profit optimization | M4 | 15 | 15 | 0 |
| Financial recovery planner | M7 | 11 | 11 | 0 |
| Privacy-preserving financial benchmarking | M7 | 21 | 21 | 0 |
| Internationalization | M8 | 16 | 13 | 3 |
| Integration marketplace | M6 | 50 | 50 | 0 |
| Security and enterprise governance | M1 | 38 | 30 | 8 |
| User experience and onboarding | M1 | 22 | 18 | 4 |
| Accounting data migration | M6 | 20 | 20 | 0 |
| Subscription and monetization engine | M9 | 32 | 32 | 0 |
| Platform super admin | M9 | 22 | 22 | 0 |
| Mobile experience | M8 | 16 | 15 | 1 |
| Performance and scalability | M9 | 21 | 19 | 2 |
| Testing and quality assurance | M1 | 31 | 12 | 19 |
| Demonstration data | M1 | 21 | 19 | 2 |
| Additional differentiating innovations | M7 | 18 | 18 | 0 |
| Navigation structure | M1 | 48 | 39 | 9 |
| Design system | M1 | 36 | 36 | 0 |
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

### TAX-002 — Do not hard-code global tax rates

- Module: Global taxation engine
- Status: **Tested**
- Notes: Rates are tenant-configured; no statutory rates are hard-coded.
- Evidence:
  - apps/api/src/tax-rates
  - apps/web/e2e/sales-flow.test.mjs

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
- Notes: Application-level scoping plus database foreign keys. PostgreSQL row-level security is not enabled yet (see KNOWN_LIMITATIONS).
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › tenant isolation
  - Composite (id, org_id) foreign keys in schema

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
- Status: **Implementing**
- Notes: Short-lived JWT held in an httpOnly SameSite=Lax cookie by the web app. Refresh tokens, revocation and session listing are not done.
- Evidence:
  - apps/api/src/auth/tokens.service.ts
  - apps/web/src

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
- Notes: Email + password (scrypt) and HS256 JWT bearer tokens.
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › authentication

### SEC-017 — Input validation

- Module: Security and enterprise governance
- Status: **Tested**
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › rejects unbalanced, malformed and header-account entries
  - zod schemas on every endpoint

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
- Status: **Implemented**
- Notes: Members screen lists members and adds an existing user by email with a role. Invitation emails and role changes are not built.
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › roles and permissions
  - apps/web/src

### MOB-001 — Create a responsive web application first

- Module: Mobile experience
- Status: **Implementing**
- Notes: Layouts are responsive and checked at phone width; no dedicated mobile navigation pattern yet.
- Evidence:
  - apps/web/src

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
- Status: **Implemented**
- Notes: Member list and add-by-email with a role; invitation emails and role changes are not built.
- Evidence:
  - apps/web/src

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

