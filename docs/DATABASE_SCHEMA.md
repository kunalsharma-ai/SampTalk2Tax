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
| `auth_sessions` | Signed-in sessions: SHA-256 of the current and previous refresh secret, rotation time and count, browser and address, created / last used / hard expiry, revocation time and reason | revoked ⇔ reason; expiry after creation |
| `login_throttles` | Failed sign-ins per email (with or without an account): count, first failure, locked until | failures ≥ 0 |
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
| `bank_statement_imports` | One uploaded statement file: account, file name and SHA-256, new and skipped line counts, date range | counts ≥ 0, first ≤ last date |
| `bank_statement_lines` | What the bank says moved: date, description, reference, signed amount (+ in, − out), fingerprint, status UNMATCHED / MATCHED / EXCLUDED, reconciliation link | amount ≠ 0; excluded ⇔ reason; unique `(org_id, account_id, fingerprint)` so overlapping files never double-import |
| `bank_matches` | Statement line ↔ posted journal line on the same bank account; origin EXISTING / CREATED_ENTRY / CREATED_PAYMENT. Never deleted: unmatching sets `removed_at` | **a journal line has at most one active match** (partial unique index) |
| `bank_reconciliations` | Account, start and statement date, opening and statement balance, ledger balance, uncleared total; COMPLETED or UNDONE (with reason) | one COMPLETED per account and statement date (partial unique index) |
| `allocations` | Payment or credit document → invoice/bill. Never deleted: removal sets `removed_on` / `removed_by_id` | amount > 0; exactly one source |
| `attachments` | Evidence files on a document, payment, journal entry or bank statement line: bytes (`bytea`), detected content type, size, SHA-256, uploader; removal sets `removed_at` and a reason | size 1 byte–5 MB and equal to the stored bytes; SHA-256 format; PDF/PNG/JPEG/WebP only; removed ⇔ reason |
| `approval_policies` | One rule per org and document type: minimum total, separate approver required, active | unique `(org_id, document_kind)`; minimum ≥ 0 |
| `approval_requests` | One request to approve one draft: snapshot of kind, contact name and total; PENDING → APPROVED / REJECTED / CANCELLED; requester, decider, notes. The document link becomes NULL if the draft is deleted | **one open (pending or approved) request per document** (partial unique index); total > 0; decided ⇔ not pending |
| `expense_claims` | One person's claim: number, claimant, title, totals; DRAFT → SUBMITTED → APPROVED → REIMBURSED (or REJECTED, VOID); approver, posting, reimbursement and void journals | total = net + tax; status consistent with its journals and decision (CHECK); unique `(org_id, number)` |
| `expense_claim_lines` | Date, expense account, merchant, description, amount paid (tax included), tax rate and the net/tax split | amount > 0 and = net + tax; FKs `(claim_id, org_id)`, `(account_id, org_id)`, `(tax_rate_id, org_id)` |
| `audit_events` | Append-only, hash-chained audit trail | UPDATE/DELETE blocked by trigger |

## Integrity triggers

| Trigger | Enforces |
|---|---|
| `journal_entries_guard` (BEFORE) | Posted entries cannot be updated or deleted; posting requires the period to be OPEN; entry date must fall within its period |
| `journal_lines_guard` (BEFORE) | Lines of a posted entry cannot be inserted, updated or deleted |
| `journal_entries_balanced` (DEFERRED constraint trigger) | At commit, a posted entry has ≥ 2 lines, functional debits = credits, and header totals match the lines |
| `journal_lines_account_check` (BEFORE) | Lines may only reference postable, active accounts |
| `audit_events_append_only` (BEFORE) | Audit events cannot be updated or deleted |
| `journal_lines_control_account_check` (BEFORE) | Manual and bank-entry journals cannot touch the receivables / payables control accounts (`organizations.ar_account_id`, `ap_account_id`) or employee reimbursements payable (`claims_account_id`); only document, payment and expense-claim postings can |
| `documents_guard`, `document_lines_guard` (BEFORE) | Posted documents and their lines are immutable; the only allowed change is a single transition to VOID with its void journal |
| `payments_guard` (BEFORE) | Same for payments |
| `allocations_guard` (BEFORE) | Allocations cannot be deleted or changed, except setting `removed_on` once |
| `allocations_checked` (DEFERRED constraint trigger) | At commit: source and target are posted, belong to the same contact and ledger, and neither the target nor the source is over-allocated |
| `documents_void_check`, `payments_void_check` (BEFORE) | Cannot void while active allocations exist |
| `bank_statement_lines_guard` (BEFORE) | Statement lines are never deleted and what the bank said (date, amount, text, account) never changes; a reconciled line's status is frozen; only matched or excluded lines can be reconciled |
| `bank_matches_guard` (BEFORE) | Matches are never deleted, only removed once, and not while their line is reconciled |
| `bank_matches_checked`, `bank_statement_lines_checked` (DEFERRED constraint triggers) | At commit: a MATCHED line's active matches are posted lines on the same bank account whose net equals the statement amount; other lines have no active matches |
| `bank_reconciliations_guard` (BEFORE) | Reconciliations are never deleted; figures never change; a completed one can be undone once |
| `expense_claims_guard` (BEFORE) | Only drafts can be deleted; claimant, number and org never change; content changes only while draft or rejected; allowed status moves only; a submitted claim must add up to its lines; the approver is never the claimant |
| `auth_sessions_guard` (BEFORE) | A session never changes user; once revoked it stays revoked and its secret is frozen; its hard expiry can only move earlier |
| `expense_claim_lines_guard` (BEFORE) | Lines change only while the claim is a draft or rejected |
| `attachments_guard` (BEFORE) | Attachments are never deleted; the bytes, name, type and record never change; removal happens once |
| `approval_requests_guard` (BEFORE) | Requests are never deleted and only for drafts in the same org; status moves only PENDING → APPROVED/REJECTED/CANCELLED or APPROVED → CANCELLED; an approval must come from someone other than the requester and the document's creator unless the rule allows it |
| `documents_invalidate_approval`, `document_lines_invalidate_approval` (AFTER) | Any change to a draft or its lines cancels its open request |
| `documents_approval_check` (BEFORE) | A document covered by an active rule can become POSTED only with an APPROVED request for exactly its total |

The control-account trigger also refuses bank-entry journals (`source = BANK`) on the receivables / payables accounts; money from customers and to vendors is recorded as a receipt or payment instead.

All are exercised by `apps/api/test/ledger.e2e.test.ts` and `apps/api/test/sales-purchases.e2e.test.ts`, including direct-SQL tampering attempts. The M2 triggers are in migrations `20261031171500_sales_purchases` and `20261031180000_banking` (exercised by `apps/api/test/banking.e2e.test.ts`) `20261031190000_attachments_approvals` (exercised by `apps/api/test/attachments-approvals.e2e.test.ts`) `20261031200000_expense_claims` (exercised by `apps/api/test/expenses.e2e.test.ts`) and `20261031210000_auth_sessions` (exercised by `apps/api/test/sessions-security.e2e.test.ts`).

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
accounts (bank) 1─* bank_statement_imports 1─* bank_statement_lines 1─* bank_matches *─1 journal_lines
accounts (bank) 1─* bank_reconciliations 1─* bank_statement_lines
```

## Planned additions

Dimension masters (cost centre, department, project, location), recurring journal templates, exchange-rate tables, tax rules with effective dating (M3), row-level security policies.
