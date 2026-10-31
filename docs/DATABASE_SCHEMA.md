# Database schema

PostgreSQL 16. Schema source: `packages/database/prisma/schema.prisma`. Migrations: `packages/database/prisma/migrations/` (the first migration also contains the hand-written integrity controls).

## Conventions

* UUID primary keys; `snake_case` tables and columns.
* Every tenant-owned row has `org_id`. Child tables reference parents with **composite foreign keys** `(id, org_id)`, so a row in one organisation physically cannot point at another organisation's account, period or entry.
* Money: `NUMERIC(24,6)`; exchange rates: `NUMERIC(24,10)`; dates: `DATE`; timestamps: `TIMESTAMPTZ(6)`.

## Tables

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | Login identities | unique `email` (stored lower-case) |
| `organizations` | Tenants. Functional currency, country, fiscal-year start month, `is_demo` | FY month 1–12 |
| `memberships` | User ↔ org with a role (OWNER, ADMIN, ACCOUNTANT, APPROVER, VIEWER) | unique `(org_id, user_id)` |
| `accounts` | Chart of accounts: code, type, subtype, parent, postable/header, active | unique `(org_id, code)`; parent FK `(parent_id, org_id)` |
| `fiscal_periods` | Monthly periods, status OPEN / LOCKED / CLOSED | unique `(org_id, fiscal_year, period_no)`; **no overlapping date ranges** per org (GiST exclusion) |
| `journal_entries` | Header: date, period, type, status DRAFT/POSTED, number, totals, idempotency key, reversal link | unique `(org_id, entry_number)`, `(org_id, idempotency_key)`, `reverses_entry_id`; posted ⇒ number, poster and totals set and equal |
| `journal_lines` | Lines: account, currency, rate, debit/credit in transaction and functional currency, description, dimensions (JSON) | one positive side only, non-negative, positive rate; FKs `(entry_id, org_id)` and `(account_id, org_id)` |
| `org_counters` | Per-org sequences (journal numbers, `doc:INVOICE`, `doc:RECEIPT`, …) | PK `(org_id, key)` |
| `contacts` | Customers and vendors (one row can be both): terms, credit limit, tax ID as entered | must be customer or vendor; terms 0–3650; limit ≥ 0 |
| `tax_rates` | Tenant-configured percentages with the account tax on sales / purchases posts to | rate 0–100, immutable once created; unique `(org_id, name)` |
| `documents` | Invoices, credit notes, bills, vendor credits. DRAFT → POSTED → VOID, with links to the posting and void journals | total = subtotal + tax > 0; due ≥ issue; status fields consistent; unique `(org_id, kind, number)`; **one bill per vendor reference** (case-insensitive partial unique index) |
| `document_lines` | Account, quantity, unit price, tax rate, net and tax amount | quantity > 0, amounts ≥ 0; FKs `(document_id, org_id)`, `(account_id, org_id)`, `(tax_rate_id, org_id)` |
| `payments` | Receipts and vendor payments from a bank/cash account; POSTED or VOID; idempotency key + body hash | amount > 0; unique `(org_id, idempotency_key)` |
| `allocations` | Payment or credit document → invoice/bill. Never deleted: removal sets `removed_on` / `removed_by_id` | amount > 0; exactly one source |
| `audit_events` | Append-only, hash-chained audit trail | UPDATE/DELETE blocked by trigger |

## Integrity triggers

| Trigger | Enforces |
|---|---|
| `journal_entries_guard` (BEFORE) | Posted entries cannot be updated or deleted; posting requires the period to be OPEN; entry date must fall within its period |
| `journal_lines_guard` (BEFORE) | Lines of a posted entry cannot be inserted, updated or deleted |
| `journal_entries_balanced` (DEFERRED constraint trigger) | At commit, a posted entry has ≥ 2 lines, functional debits = credits, and header totals match the lines |
| `journal_lines_account_check` (BEFORE) | Lines may only reference postable, active accounts |
| `audit_events_append_only` (BEFORE) | Audit events cannot be updated or deleted |
| `journal_lines_control_account_check` (BEFORE) | Manual journals cannot touch the receivables / payables control accounts (`organizations.ar_account_id`, `ap_account_id`); only document and payment postings can |
| `documents_guard`, `document_lines_guard` (BEFORE) | Posted documents and their lines are immutable; the only allowed change is a single transition to VOID with its void journal |
| `payments_guard` (BEFORE) | Same for payments |
| `allocations_guard` (BEFORE) | Allocations cannot be deleted or changed, except setting `removed_on` once |
| `allocations_checked` (DEFERRED constraint trigger) | At commit: source and target are posted, belong to the same contact and ledger, and neither the target nor the source is over-allocated |
| `documents_void_check`, `payments_void_check` (BEFORE) | Cannot void while active allocations exist |

All are exercised by `apps/api/test/ledger.e2e.test.ts` and `apps/api/test/sales-purchases.e2e.test.ts`, including direct-SQL tampering attempts. The M2 triggers are in migration `20261031171500_sales_purchases`.

## Entity relationships

```
organizations 1─* memberships *─1 users
organizations 1─* accounts (self-referencing parent)
organizations 1─* fiscal_periods 1─* journal_entries 1─* journal_lines *─1 accounts
journal_entries 0..1─1 journal_entries (reverses / reversed_by)
organizations 1─* audit_events
organizations 1─* contacts 1─* documents 1─* document_lines *─0..1 tax_rates
contacts 1─* payments
documents/payments 1─0..1 journal_entries (posting) and 0..1 (void)
payments | credit documents 1─* allocations *─1 documents (invoice / bill)
```

## Planned additions

Dimension masters (cost centre, department, project, location), recurring journal templates, exchange-rate tables, bank accounts and statement lines (M2, next slice), tax rules with effective dating (M3), row-level security policies.
