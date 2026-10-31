# Milestone report — M2 core finance

## Slice 1: receivables and payables

Date: 2026-10-31

### Completed and tested
* Customers and vendors (one contact can be both), payment terms, credit limits, tax ID stored as entered.
* Tenant-configured tax rates with sales (liability) and purchase (asset) accounts; rate immutable after creation.
* Invoices, credit notes, bills and vendor credits: draft, edit, delete draft, post, void with reason. Totals are rounded per line (half-even) and recomputed on posting; a changed total is refused.
* Posting goes through the general ledger engine: invoice Dr receivables / Cr revenue and tax; bill Dr expense and input tax / Cr payables; credits the reverse; void posts an exact reversal.
* Receivables and payables control accounts are closed to manual journals (API and database trigger).
* Receipts and vendor payments from a bank or cash account, with allocation at entry or later, unapplied amounts kept as credit, `Idempotency-Key` support, and void.
* Credit notes and vendor credits applied to invoices and bills. Allocations are never deleted; removal keeps the record.
* Database guards: posted documents, lines, payments and allocations immutable; deferred over-allocation check; no void while allocations exist; one bill per vendor reference.
* Credit-limit check on posting with an audited override; duplicate vendor-invoice detection.
* Customer and vendor statements with opening and running balances.
* Receivables and payables ageing as of any date, reconciled to the control-account balance.
* Permissions: contacts, sales and purchases read/manage; approvers can post drafts but not create them.
* Web app: customers, invoices, receipts, receivables ageing, vendors, bills, payments, payables ageing, tax rates, contact detail with statement; journals screen hides Reverse for system entries.
* Demo seed posts synthetic invoices, bills, receipts and payments; both ageings tie to the ledger.

### Tests
* Engine: `packages/accounting-engine/test/documents.test.ts`, including a property test for document totals.
* API integration: 22 new tests (`apps/api/test/sales-purchases.e2e.test.ts`), including direct-SQL tampering, concurrent receipts and cross-tenant access.
* Browser: 9 new steps (`apps/web/e2e/sales-flow.test.mjs`).

### Not in slice 1
Expenses; approval workflows; multi-currency documents; statutory tax; PDFs and email; recurring billing; quotes and orders. See [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md).

## Slice 2: banking and reconciliation

### Completed and tested
* Bank and cash accounts list with ledger balance, lines to review and last reconciliation; new bank account from the screen.
* CSV statement import: server-side parsing with exact decimals, five date formats, single or split amount columns, brackets and DR/CR, preview before storing, column detection from bank header names, duplicate skipping across overlapping files, refusal of lines inside a reconciled period.
* Rule-based match suggestions (amount, date, shared words) and auto-match of unambiguous pairs only.
* Manual matching to one or more ledger lines that add up to the statement line.
* From a statement line: record a customer receipt or vendor payment with allocations, or post a bank entry to any non-control account. Unmatching an entry created from a line reverses it.
* Exclusion with a reason, and inclusion again.
* Reconciliation: statement-total check, all lines resolved, ledger less uncleared equals statement; completion locks the lines; history; undo of the latest one by owners and admins with a reason.
* Database guards: immutable statement lines, one active match per ledger line, matched amounts net to the statement amount at commit, matches and reconciliations never deleted, reconciled lines frozen. Matched journals cannot be reversed or voided until unmatched.
* Permissions: banking.read / banking.manage / banking.reconcile.
* Demo seed imports a synthetic statement for the current month.

### Tests
* Engine: `packages/accounting-engine/test/bank.test.ts` (12).
* API integration: `apps/api/test/banking.e2e.test.ts` (17), including direct-SQL tampering, concurrent matching and cross-tenant access.
* Browser: `apps/web/e2e/banking-flow.test.mjs` (8 steps).

### Not in slice 2
Live bank feeds, OFX/QIF import, foreign-currency bank accounts, many-to-one matching, transfer detection, learning suggestions. See [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md).

## Slice 3: attachments and approvals

### Completed and tested
* Attachments on invoices, credit notes, bills, vendor credits, receipts, payments and journal entries, from the record's page: upload several files at once, open or download, remove with a reason, show removed files.
* Server rules: raw-byte upload, type detected from the first bytes (PDF, PNG, JPEG, WebP only), 5 MB per file, 20 per record, exact duplicates refused, cleaned file names, record-level permissions (who can read or change the record can read or change its files), downloads served byte for byte with `nosniff`, a sandbox CSP and a checksum header. The web proxy now passes binary bodies and download headers through.
* Database guards: attachment bytes and metadata never change, rows are never deleted, removal happens once.
* Approval rules per document type: on/off, minimum total, whether the approver must be someone else. Set by owners and admins on an Approval rules screen.
* Approval requests: submit a covered draft, approve (optionally posting straight away), reject with a reason, withdraw. Approvals inbox with Waiting / Approved / Rejected / All. The document page shows where the draft stands and disables Post until it is approved.
* Database guards: a covered document cannot become POSTED without an APPROVED request for exactly its total; the approver must differ from the preparer and the submitter when the rule says so; editing a draft or its lines cancels its open request; requests are never deleted and keep a snapshot when the draft is deleted.
* New permission `approvals.decide` (Owner, Admin, Approver).
* Demo seed turns on a rule for bills from 250,000 and leaves one synthetic draft bill with a synthetic PDF waiting for approval.

### Tests
* API integration: `apps/api/test/attachments-approvals.e2e.test.ts` (12), including magic-byte checks, size limits, cross-tenant and per-role access, direct-SQL tampering with files and approvals, and a posting failure after approval.
* Browser: `apps/web/e2e/approvals-flow.test.mjs` (5 steps, two signed-in users).

### Not in slice 3
OCR and extraction, a document vault, malware scanning, object storage, multi-level approval chains, approvals for payments and journals, notifications, and a screen for files on bank lines. See [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md).

## Slice 4: employee expense claims

### Completed and tested
* New EMPLOYEE role: sees only "My expense claims"; every ledger, report, banking and audit endpoint refuses it. Other roles can also claim their own expenses.
* Claims with lines of date, category (an expense account), merchant, description, the amount paid with tax included, and an optional tax rate; the recoverable tax is split out half-even in the accounting engine, the same calculation in the browser and on the server.
* Draft, edit, submit, withdraw, reject with a reason, fix and resubmit; delete drafts.
* Approval by someone other than the claimant (service and database) posts Dr expenses and input tax / Cr Employee Reimbursements Payable (2250, a new control account closed to manual and bank journals; created on first use for older organisations).
* Pay back from a bank or cash account with a reference (Dr Employee Reimbursements Payable / Cr bank); the bank line can then be matched on the banking screen. Void an approved, unpaid claim (reverses the posting).
* Receipts via attachments: claimants add them until approval, finance can add evidence any time, nobody else can see them. Warnings for claims without receipts and for lines with the same date and amount as another claim by the same person.
* Lists: my claims with totals waiting / to be paid / paid, to approve, to pay back, all claims.
* Demo seed: a synthetic employee with one paid, one waiting (with a receipt) and one draft claim.

### Tests
* Engine: `packages/accounting-engine/test/expenses.test.ts` (5).
* API integration: `apps/api/test/expenses.e2e.test.ts` (12), including role isolation, receipts privacy, SQL tampering, self-approval in SQL, void, and lazy creation of the reimbursements account.
* Browser: `apps/web/e2e/expenses-flow.test.mjs` (6 steps, employee and owner).

### Not in slice 4
Expense policies and limits, mileage and per diem, foreign-currency receipts, OCR, card feeds, batch reimbursements, manager hierarchies. See [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md).
