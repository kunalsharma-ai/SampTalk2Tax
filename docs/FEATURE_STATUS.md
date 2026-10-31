# Feature status

_Generated. Source of truth: `features/status.json` (status + evidence) merged into `features/registry.json`._

A feature counts as **Implemented** only when its business logic, persistence, API **and UI** work. Backend-complete features without UI are reported as **Implementing** with evidence, never as Implemented.

## Summary

| Status | Count |
|---|---|
| Not started | 1273 |
| Designed | 0 |
| Implementing | 31 |
| Implemented | 0 |
| Tested | 39 |
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
| Accounts receivable | M2 | 43 | 43 | 0 |
| Accounts payable | M2 | 36 | 36 | 0 |
| Banking and reconciliation | M2 | 24 | 24 | 0 |
| Global taxation engine | M3 | 54 | 54 | 0 |
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
| Dashboard design | M1 | 68 | 68 | 0 |
| Executive financial command center | M4 | 38 | 38 | 0 |
| AI financial war room | M7 | 17 | 17 | 0 |
| Revenue leakage and profit optimization | M4 | 15 | 15 | 0 |
| Financial recovery planner | M7 | 11 | 11 | 0 |
| Privacy-preserving financial benchmarking | M7 | 21 | 21 | 0 |
| Internationalization | M8 | 16 | 14 | 2 |
| Integration marketplace | M6 | 50 | 50 | 0 |
| Security and enterprise governance | M1 | 38 | 30 | 8 |
| User experience and onboarding | M1 | 22 | 18 | 4 |
| Accounting data migration | M6 | 20 | 20 | 0 |
| Subscription and monetization engine | M9 | 32 | 32 | 0 |
| Platform super admin | M9 | 22 | 22 | 0 |
| Mobile experience | M8 | 16 | 16 | 0 |
| Performance and scalability | M9 | 21 | 19 | 2 |
| Testing and quality assurance | M1 | 31 | 15 | 16 |
| Demonstration data | M1 | 21 | 19 | 2 |
| Additional differentiating innovations | M7 | 18 | 18 | 0 |
| Navigation structure | M1 | 48 | 48 | 0 |
| Design system | M1 | 36 | 36 | 0 |
| Absolute quality rules | All | 20 | 13 | 7 |

## Features with progress and evidence

### GL-001 — Create a full enterprise-grade accounting foundation

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Foundation in place (ledger, journals, periods, reports). Most GL capabilities below are still to do.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts

### GL-002 — Double-entry bookkeeping

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - packages/accounting-engine/test/journal.test.ts
  - apps/api/test/ledger.e2e.test.ts › journal posting

### GL-003 — Configurable chart of accounts

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented. A generic SMB template is applied on onboarding; statutory charts per country are not done.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › chart of accounts rules
  - POST/PATCH /v1/orgs/:orgId/accounts

### GL-004 — Hierarchical account structures

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › validates hierarchy, subtype and uniqueness

### GL-005 — Account types and subtypes

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › validates hierarchy, subtype and uniqueness

### GL-006 — Journal entries

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › journal posting
  - POST /v1/orgs/:orgId/journals (draft, edit, delete, post)

### GL-008 — Adjusting journals

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented. ADJUSTING is a journal type; dedicated adjustment workflow (e.g. auto-reverse next period) not done.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts

### GL-009 — Reversing journals

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › reverses a posted entry exactly once and nets it to zero
  - packages/accounting-engine/test/journal.test.ts › builds a reversal that nets the original to zero

### GL-010 — Opening balances

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented. OPENING is a journal type; an opening-balance import wizard is not done.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts

### GL-013 — Accrual accounting

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: The ledger records accruals (AR/AP based entries). Accrual vs cash reporting basis switch is not done.
- Evidence:
  - packages/accounting-engine/test/reports.test.ts

### GL-015 — Multi-period accounting

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › creates further fiscal years
  - packages/accounting-engine/test/periods.test.ts

### GL-016 — Financial periods

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - packages/accounting-engine/test/periods.test.ts
  - apps/api/test/ledger.e2e.test.ts › period locks

### GL-017 — Fiscal calendars

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented. Monthly calendars with any start month; 4-4-5 and custom calendars not done.
- Evidence:
  - packages/accounting-engine/test/periods.test.ts › generates an April-March fiscal year

### GL-018 — Period locks

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › blocks posting into a locked period and allows it again after unlock
  - packages/database/prisma/migrations/*_init/migration.sql (integrity triggers)

### GL-019 — Posting controls

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented. Draft → post with separate permissions; configurable approval policies not done.
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › roles and permissions
  - apps/api/test/ledger.e2e.test.ts › journal posting

### GL-020 — Audit history

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › audit trail

### GL-021 — Trial balance

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › financial reports
  - packages/accounting-engine/test/reports.test.ts

### GL-022 — General ledger reports

- Module: General ledger and accounting engine
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › builds an account ledger with opening and running balances

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

### AUDIT-004 — Audit trails

- Module: Continuous audit and governance
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented. Append-only, SHA-256 hash-chained per organization.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › audit trail
  - GET /v1/orgs/:orgId/audit-events, /verify

### AUDIT-005 — Transaction history

- Module: Continuous audit and governance
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts

### I18N-002 — Multi-currency accounting

- Module: Internationalization
- Status: **Implementing**
- Notes: Transaction currency + rate per line, functional currency per org. Rate tables, revaluation and multi-currency reporting are not done.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › converts foreign-currency lines

### I18N-010 — Configurable fiscal years

- Module: Internationalization
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - packages/accounting-engine/test/periods.test.ts

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
- Notes: Short-lived JWT access tokens only. Refresh tokens, revocation and session listing are not done.
- Evidence:
  - apps/api/src/auth/tokens.service.ts

### SEC-012 — Secrets management

- Module: Security and enterprise governance
- Status: **Implementing**
- Notes: Secrets come from environment variables and are validated at startup; no secrets in code. A secrets manager integration is not done.
- Evidence:
  - .env.example
  - apps/api/src/config.ts

### SEC-014 — Audit logging

- Module: Security and enterprise governance
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/ledger.e2e.test.ts › audit trail

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
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › organization onboarding

### UX-007 — Configure fiscal year

- Module: User experience and onboarding
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › organization onboarding

### UX-008 — Configure currency

- Module: User experience and onboarding
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented.
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › organization onboarding

### UX-015 — Configure team roles

- Module: User experience and onboarding
- Status: **Implementing**
- Notes: Backend logic, persistence, REST API and automated tests are done. The web UI is not built yet, so this is not Implemented. Existing users can be added with a role; email invitations are not done.
- Evidence:
  - apps/api/test/auth-tenancy.e2e.test.ts › roles and permissions

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
  - apps/api/test/auth-tenancy.e2e.test.ts › roles and permissions

### QA-012 — Permission tests

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

