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
| `invitations` | Invitation to join an org with a role: lower-case email, SHA-256 of the link token, inviter, expiry, accepted / revoked by and when | one open invitation per org and email (partial unique index); accepted and revoked exclusive; never deleted |
| `auth_sessions` | Signed-in sessions: SHA-256 of the current and previous refresh secret, rotation time and count, browser and address, created / last used / hard expiry, revocation time and reason | revoked ⇔ reason; expiry after creation |
| `login_throttles` | Failed sign-ins per email (with or without an account): count, first failure, locked until | failures ≥ 0 |
| `organizations` | Tenants. Functional currency, country, fiscal-year start month, `is_demo` | FY month 1–12 |
| `memberships` | User ↔ org with a role (OWNER, ADMIN, ACCOUNTANT, APPROVER, VIEWER) | unique `(org_id, user_id)` |
| `accounts` | Chart of accounts: code, type, subtype, parent, postable/header, active | unique `(org_id, code)`; parent FK `(parent_id, org_id)` |
| `fiscal_periods` | Monthly periods, status OPEN / LOCKED / CLOSED | unique `(org_id, fiscal_year, period_no)`; **no overlapping date ranges** per org (GiST exclusion) |
| `journal_entries` | Header: date, period, type, status DRAFT/POSTED, number, totals, idempotency key, reversal link | unique `(org_id, entry_number)`, `(org_id, idempotency_key)`, `reverses_entry_id`; posted ⇒ number, poster and totals set and equal |
| `journal_lines` | Lines: account, currency, rate, debit/credit in transaction and functional currency, description, dimensions (JSON) | one positive side only, non-negative, positive rate; FKs `(entry_id, org_id)` and `(account_id, org_id)` |
| `org_counters` | Per-org sequences (journal numbers, `doc:INVOICE`, `doc:RECEIPT`, …) | PK `(org_id, key)` |
| `contacts` | Customers and vendors (one row can be both): terms, credit limit, tax ID as entered, GSTIN and GST state code | must be customer or vendor; terms 0–3650; limit ≥ 0 |
| `tax_rates` | Tenant-configured rates: SIMPLE (one account per ledger) or GST (category TAXABLE / NIL_RATED / EXEMPT / NON_GST, no accounts) | rate 0–100; GST non-taxable rates are 0; rate, kind and category immutable (trigger); unique `(org_id, name)` |
| `gst_registrations` | One per org: GSTIN, state code, legal name, effective date, six GST accounts (output/input CGST, SGST/UTGST, IGST) | GSTIN shape and state = its first two digits; six distinct accounts in the same tenant (FKs `(account_id, org_id)`); RLS |
| `withholding_settings` | One per org: TAN, TDS and TCS payable accounts | TAN format; accounts in the same tenant (FKs `(account_id, org_id)`); RLS |
| `withholding_sections` | TDS or TCS sections: code, name, rates (normal, individual/HUF, no PAN), thresholds, window, basis, validity, source, active flag | unique `(org_id, kind, code)`; rates 0–100; never deleted and the rule never changes (trigger); RLS |
| `withholding_deposits` | Challans: number, kind, date, bank account, challan reference, tax and interest, journal and void journal | amounts ≥ 0; interest needs an account; only a single move to VOID (trigger); RLS |
| `withholding_deposit_items` | Documents covered by a deposit and their amounts | one active deposit per document (partial unique index); an item is deactivated only when its deposit is VOID (trigger); RLS |
| `payroll_settings` | One per org: PF establishment, ESI employer and PT registration codes; the seven payroll accounts | account FKs `(…_account_id, org_id)`; RLS |
| `employees` | Code, name, PAN, UAN, ESI number, joining/leaving dates, work state, PT category, PF/EPS membership, previous-employer salary and TDS for a tax year | unique `(org_id, code)`; PAN format; leaving ≥ joining; prior amounts ≥ 0; EPS needs PF; RLS |
| `salary_structures` | An employee's salary from a month | unique `(employee_id, effective_from)`; `effective_from` on the 1st; never changed once created (trigger); RLS |
| `salary_components` | Code, name, kind (WAGES/EXCLUDED), monthly amount | unique `(structure_id, code)`; amount ≥ 0; added or removed only while no payslip uses the structure (trigger); RLS |
| `pay_runs` | One month's payroll: number, period, pay date, DRAFT → POSTED → VOID, posting and void journals | **one non-void run per org and month** (partial unique index); status consistent with its journals (CHECK); transitions only DRAFT → POSTED → VOID, only drafts deleted (trigger); RLS |
| `payslips` | One employee in a run: days, loss of pay, one-offs, earnings (JSON), wages, PF/ESI/PT/TDS amounts, net and employer cost, TDS working (JSON) | net = gross − deductions and the deduction sum (CHECK); written only while the run is DRAFT (trigger); RLS |
| `payroll_remittances` | Payments of a run's net pay, PF, ESI, PT or TDS: number, date, bank account, reference, amount, journal and void journal | **one posted payment per run and liability** (partial unique index); only on a POSTED run, only a single move to VOID (trigger); RLS |
| `compliance_settings` | One per org: GST return frequency (MONTHLY or QUARTERLY for QRMP) and the date advance tax tracking starts | RLS |
| `compliance_filings` | A return marked filed (or advance tax marked paid): obligation key, kind, period, due date, filing date, reference, note; FILED → VOID with who, when and why | key = kind:period and kind is a return (CHECK); **one FILED record per obligation** (partial unique index); never deleted, only a single move to VOID (trigger); RLS |
| `documents` | Invoices, credit notes, bills, vendor credits. DRAFT → POSTED → VOID, with links to the posting and void journals; GST place of supply, supplier state, nature (INTRA/INTER) and counterparty GSTIN, reverse charge and its tax, and TDS/TCS (section, kind, subject, base, rate, amount, counterparty PAN), frozen once posted | total = subtotal + tax ∓ TDS/TCS > 0; TDS only on bills and TCS only on invoices; reverse charge only on bills and vendor credits with a place of supply and tax total 0; due ≥ issue; status fields consistent; unique `(org_id, kind, number)`; **one bill per vendor reference** (case-insensitive partial unique index) |
| `document_lines` | Account, quantity, unit price, tax rate, net and tax amount; HSN/SAC and CGST, SGST/UTGST, IGST amounts | quantity > 0, amounts ≥ 0; FKs `(document_id, org_id)`, `(account_id, org_id)`, `(tax_rate_id, org_id)` |
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
| `documents_void_deposited_check` (BEFORE) | A document whose TDS/TCS is in an active challan cannot be voided |
| `withholding_sections_guard`, `withholding_deposits_guard`, `withholding_deposit_items_guard` (BEFORE) | Section rules never change and sections are never deleted; a challan only moves once to VOID; its items are released only after that |
| `salary_structures_guard`, `salary_components_guard`, `pay_runs_guard`, `payslips_guard`, `payroll_remittances_guard` (BEFORE) | Salary structures never change after creation and their components change only while no payslip uses them; pay runs move only DRAFT → POSTED → VOID and only drafts are deleted; payslips change only while their run is a draft; payroll payments are made only against a posted run and only move once to VOID. Migration `20261101180000_india_payroll`, exercised by `apps/api/test/payroll.e2e.test.ts` |
| `compliance_filings_guard` (BEFORE) | Filing records are never deleted and change only once, from FILED to VOID. Migration `20261101200000_compliance_calendar`, exercised by `apps/api/test/compliance.e2e.test.ts` |
| `bank_statement_lines_guard` (BEFORE) | Statement lines are never deleted and what the bank said (date, amount, text, account) never changes; a reconciled line's status is frozen; only matched or excluded lines can be reconciled |
| `bank_matches_guard` (BEFORE) | Matches are never deleted, only removed once, and not while their line is reconciled |
| `bank_matches_checked`, `bank_statement_lines_checked` (DEFERRED constraint triggers) | At commit: a MATCHED line's active matches are posted lines on the same bank account whose net equals the statement amount; other lines have no active matches |
| `bank_reconciliations_guard` (BEFORE) | Reconciliations are never deleted; figures never change; a completed one can be undone once |
| `expense_claims_guard` (BEFORE) | Only drafts can be deleted; claimant, number and org never change; content changes only while draft or rejected; allowed status moves only; a submitted claim must add up to its lines; the approver is never the claimant |
| `invitations_guard` (BEFORE) | Invitations are never deleted; accepted or revoked ones are frozen; email, role and organisation never change |
| `memberships_last_owner` (BEFORE) | An organisation always keeps at least one owner (owner changes serialised per org) |
| `auth_sessions_guard` (BEFORE) | A session never changes user; once revoked it stays revoked and its secret is frozen; its hard expiry can only move earlier |
| `expense_claim_lines_guard` (BEFORE) | Lines change only while the claim is a draft or rejected |
| `attachments_guard` (BEFORE) | Attachments are never deleted; the bytes, name, type and record never change; removal happens once |
| `approval_requests_guard` (BEFORE) | Requests are never deleted and only for drafts in the same org; status moves only PENDING → APPROVED/REJECTED/CANCELLED or APPROVED → CANCELLED; an approval must come from someone other than the requester and the document's creator unless the rule allows it |
| `documents_invalidate_approval`, `document_lines_invalidate_approval` (AFTER) | Any change to a draft or its lines cancels its open request |
| `documents_approval_check` (BEFORE) | A document covered by an active rule can become POSTED only with an APPROVED request for exactly its total |

The control-account trigger also refuses bank-entry journals (`source = BANK`) on the receivables / payables accounts; money from customers and to vendors is recorded as a receipt or payment instead.

All are exercised by `apps/api/test/ledger.e2e.test.ts` and `apps/api/test/sales-purchases.e2e.test.ts`, including direct-SQL tampering attempts. The M2 triggers are in migrations `20261031171500_sales_purchases` and `20261031180000_banking` (exercised by `apps/api/test/banking.e2e.test.ts`) `20261031190000_attachments_approvals` (exercised by `apps/api/test/attachments-approvals.e2e.test.ts`) `20261031200000_expense_claims` (exercised by `apps/api/test/expenses.e2e.test.ts`) `20261031210000_auth_sessions` (exercised by `apps/api/test/sessions-security.e2e.test.ts`) and `20261031220000_row_level_security` (exercised by `apps/api/test/row-level-security.e2e.test.ts`).

## Row-level security

Migration `20261031220000_row_level_security` enables and forces row-level security on every table with an `org_id`, plus `organizations`. Policies compare rows with `t2t_current_org()`, `t2t_current_user()` and `t2t_rls_bypass()`, which read the transaction-local settings the API sets (see SECURITY.md). Summary:

| Table | Visible / writable when |
|---|---|
| tables with `org_id` (all tenant tables, including `invitations` and the payroll tables) | `org_id` is the current organisation |
| `audit_events` | `org_id` is the current organisation; the global chain (`org_id` NULL) only with system access |
| `memberships` | read: current organisation or the current user's own; write: current organisation |
| `organizations` | read: current organisation or one the user belongs to; write: current organisation |

Foreign-key checks are not affected (PostgreSQL runs them without row security). **Data migrations** that touch tenant rows must first run `SELECT set_config('t2t.bypass', 'on', true);` or they will see no rows.

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

Dimension masters (cost centre, department, project, location), recurring journal templates, exchange-rate tables, tax rules with effective dating (M3).
