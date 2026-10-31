# Milestone report — M2 core finance, slice 1 (receivables and payables)

Date: 2026-10-31

## Completed and tested
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

## Tests
* Engine: `packages/accounting-engine/test/documents.test.ts`, including a property test for document totals.
* API integration: 22 new tests (`apps/api/test/sales-purchases.e2e.test.ts`), including direct-SQL tampering, concurrent receipts and cross-tenant access.
* Browser: 9 new steps (`apps/web/e2e/sales-flow.test.mjs`).

## Not in this slice
Bank accounts, statement import and reconciliation (next slice); expenses; approval workflows; multi-currency documents; statutory tax; PDFs and email; recurring billing; quotes and orders. See [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md).
