# Tax engine: India TDS, TCS and GST reverse charge

Milestone 3, slice 2. Builds on the GST module ([`TAX_ENGINE_INDIA_GST.md`](TAX_ENGINE_INDIA_GST.md)). Rules live in `packages/tax-engine/src/india/withholding.ts` (pure, decimal-only) and `packages/tax-engine/src/india/returns.ts`; posting is in `packages/accounting-engine/src/documents.ts`; the API is `apps/api/src/withholding`.

## What it does

| Area | Behaviour | Where |
|---|---|---|
| Settings | One TAN per organisation (format checked, not looked up). TDS payable (2320) and TCS payable (2321) accounts are created or chosen; they are frozen once tax has been withheld. India organisations with INR books only | `WithholdingService.saveSettings` |
| Sections | Tenant sections with code, rate, individual/HUF rate, no-PAN rate, single-document and aggregate thresholds, window (tax year or month), basis (whole amount or excess only) and validity. Templates from the Income-tax Act 2025 s.393(1) table: contractors 6(i), technical fees 6(iii)(a), professional fees 6(iii)(b), commission 1(ii), rent of plant 2(ii)(a), rent of land/building 2(ii)(b), purchase of goods 8(ii). A section's rule never changes (DB trigger); deactivate it and add a new one when the law changes | `TDS_TEMPLATES`, migration `20261101150000_tds_tcs_reverse_charge` |
| PAN | Stored on the contact; taken from the GSTIN when there is one (DB check). The 4th character gives the holder type, which decides the individual/HUF rate. Without a PAN the higher of the no-PAN rate and the section rate applies | `checkPan`, `withholdingRate` |
| Threshold | History is the POSTED documents of the same contact and section in the window. "Exceeds" means strictly greater. Whole basis: tax the document if it exceeds the single-document threshold, or once the aggregate exceeds the aggregate threshold tax the aggregate less what was already taxed (catch-up). Excess basis: tax only the part above the threshold. Amounts round to the paisa, half-even | `computeWithholding` |
| TDS | On bills, on the amount before GST. Posts Cr TDS payable and reduces the vendor's balance (Cr AP = total − TDS) | `applyWithholding`, `buildDocumentJournal` |
| TCS | On invoices, on the invoice value including GST. Posts Cr TCS payable and increases what the customer owes (Dr AR = total + TCS). TCS sections are tenant-defined | same |
| Preview | The bill and invoice form ask the API for the tax as you type (`POST /withholding/preview`); posting recomputes it under a lock on the contact and refuses if it changed | `WithholdingService.preview`, `DocumentsService.post` |
| Register | By quarter: every document with a section (including those under the threshold and voided ones), totals by section, to deposit with due dates (7th of the next month; 30 April for March) and overdue, and a check against the payable account's balance | `WithholdingService.register` |
| Challans | Record one deposit for chosen documents: date, bank account, challan reference and optional interest. Posts Dr payable (+ interest expense), Cr bank (journal source TAX). A deposit can be voided (its journal is reversed and its documents are free again). A document whose tax is in a deposit cannot be voided (DB trigger) | `createDeposit`, `voidDeposit` |
| Reverse charge | Bills and vendor credits can be under reverse charge. GST stays on the lines, but the document's tax total is 0 and the vendor is owed the amount without GST. The tax posts as Dr input GST and Cr output GST (same heads). A vendor outside India (state 96) is import of services: IGST | `applyReverseCharge`, `DocumentsService.prepareGst` |
| GSTR-3B | 3.1(d) inward supplies liable to reverse charge; 4(A)(2) import of services, 4(A)(3) other reverse charge, 4(A)(5) all other ITC; reverse-charge tax is paid in cash (s.49(4)) and shown in 6.1; the ledger check includes it | `gstr3bSummary` |

## Not supported yet (do not rely on these)

* Lower or nil deduction certificates, nil declarations (Form 15G/15H equivalents), and threshold exemptions that depend on the payer's turnover.
* TDS on advances, on vendor credits or on payments (it is taken on the bill only); TDS deducted by customers (TDS receivable); TCS on receipts.
* Statements and certificates: no Form 140/143 (formerly 26Q/27EQ) file, no Form 16A, no TRACES or income-tax portal connection; nothing is filed.
* Interest and late fees are entered by the user on the challan, not computed.
* Reverse charge: no self-invoice or payment voucher, no import of goods (customs), no reverse charge on sales by e-commerce operators.
* One section per document.

## Sources (verified 2026-11-01)

* Income-tax Act 2025, s.393(1) table (payments to residents) as published by the Income Tax Department for tax years from 1 April 2026. The no-PAN rates (20%, and 5% for purchase of goods) are defaults the tenant must confirm.
* CGST Act 2017 s.9(3), s.9(4), s.49(4); IGST Act 2017 s.5(3) and s.13 (import of services).
* GSTR-3B layout tables 3.1(d), 4(A)(2), 4(A)(3), 4(A)(5), 6.1.

## Tests

* `packages/tax-engine/test/withholding.test.ts` — PAN and TAN checks, tax years and quarters, due dates, rates, thresholds (single, aggregate catch-up, excess, monthly).
* `packages/tax-engine/test/returns.test.ts` — GSTR-3B with reverse charge and import of services.
* `apps/api/test/withholding.e2e.test.ts` — settings, sections, PAN on contacts, TDS and TCS posting, catch-up, no-PAN rate, reverse charge, register, challans and void, immutability, tenant isolation.
* `apps/web/e2e/withholding-flow.test.mjs` — the browser flow from TAN to a deposited challan, with a reverse-charge bill.

## Maintenance

When the table changes, add new templates with their `validFrom` and source in `TDS_TEMPLATES`, add a test, and update this file. Existing tenant sections keep their rule; tenants add the new one and deactivate the old one.
