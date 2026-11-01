# Milestone report: M3 tax and payroll (India)

Date: 2026-11-01. Pull requests #10 to #15, each stacked on the one before.

M3 covers India: GST, TDS/TCS, payroll, a compliance calendar, e-invoicing and e-way bills. The statutory rules live in `packages/tax-engine`, which is pure TypeScript with no framework or database code. The API and the web app use it, and the browser shows the same results the server checks.

**Talk2Tax files nothing and connects to no government portal.** Requirement TAX-027 allows submission only through an approved GSP/ASP integration, which is not built. Every module prepares what the portal takes (working papers, JSON) and records what the user did on the portal.

## Slice 1: GST (PR #10)

* GST registration with GSTIN check (format, state code, checksum).
* GST rates with kind and category (taxable, nil-rated, exempt, non-GST, zero-rated), HSN/SAC on lines, and place of supply on documents.
* The CGST/SGST/UTGST/IGST split, worked out per line and posted to separate accounts.
* GSTR-1 and GSTR-3B working papers, with input tax credit set-off and a check against the ledger.
* Details: [`TAX_ENGINE_INDIA_GST.md`](TAX_ENGINE_INDIA_GST.md).

## Slice 2: TDS/TCS and GST reverse charge (PR #11)

* TDS and TCS under the Income-tax Act 2025 section templates.
* PAN on contacts, thresholds (single, aggregate with catch-up), and the higher rate without a PAN.
* TDS shown before posting on bills, and TCS on invoices; a quarterly register; challans with void.
* GST reverse charge on bills, including import of services.
* Details: [`TAX_ENGINE_INDIA_TDS_TCS.md`](TAX_ENGINE_INDIA_TDS_TCS.md).

## Slice 3: payroll (PR #12)

* Employees and salary structures dated from a month.
* Monthly pay runs with PF/EPS/EDLI (the ₹25,000 wage ceiling from 17 September 2026), ESI, Maharashtra professional tax and new-regime TDS on salary.
* Posting to the ledger, and payments of net pay and each statutory due.
* Printable payslips.
* The payroll rules have not yet been reviewed by a payroll professional. The Maharashtra PT slabs come from a secondary source; this is flagged in the doc.
* Details: [`PAYROLL_INDIA.md`](PAYROLL_INDIA.md).

## Slice 4: compliance calendar (PR #13)

* GST (monthly or QRMP), TDS/TCS deposits and statements, payroll dues and advance tax, with due dates.
* Payments are settled from the records already in Talk2Tax (challans, payroll payments). Returns are marked filed by hand.
* Details: [`COMPLIANCE_CALENDAR_INDIA.md`](COMPLIANCE_CALENDAR_INDIA.md).

## Slice 5: e-invoicing (PR #14)

* INV-01 (schema 1.1) JSON for the IRP, for one document or in bulk.
* The IRP response is imported and checked against the document, with an RS256 signature check when the user saves the IRP's key. The signed QR code is drawn on the invoice.
* The 30-day reporting limit for AATO of ₹10 crore and above, and cancellation within 24 hours.
* No void with a live IRN.
* Details: [`E_INVOICING_INDIA.md`](E_INVOICING_INDIA.md).

## Slice 6: e-way bills (PR #15)

* Which invoices need one: goods value with GST over ₹50,000 or a state's own threshold, and the 180-day limit.
* The portal's bulk JSON with Part B.
* Validity under Rule 138(10), vehicle changes, and cancellation within 24 hours.
* No void with a live e-way bill.
* Details: [`E_WAY_BILLS_INDIA.md`](E_WAY_BILLS_INDIA.md).

## How the rules are enforced

* **Records cannot be changed after the fact.** Tax and payroll records are guarded by database triggers and CHECK constraints as well as by the API. Posted documents and their tax, challans, payslips, filings, IRNs and e-way bills change only along their allowed moves.
* **Tenants are kept apart.** Every new table has forced row-level security.
* **Changes are traceable.** Every change is in the hash-chained audit trail.
* **Money is decimal throughout.** It is stored as `numeric`, worked out with decimal.js, and rounded half-even per line.

## Tests at the end of M3

All tests pass on PR #15:

* tax-engine: 89 tests;
* API integration: 209 tests, run against PostgreSQL;
* browser: 76 tests.

The M3 test files are as follows.

* **Engine:** `gstin`, `gst`, `returns`, `withholding`, `payroll`, `calendar`, `einvoice`, `ewaybill` (in `packages/tax-engine/test/`).
* **API:** `gst`, `withholding`, `payroll`, `compliance`, `e-invoicing`, `e-way-bills` (in `apps/api/test/`). They include direct-SQL tampering, viewer access and cross-tenant access.
* **Browser:** `tax-flow`, `withholding-flow`, `payroll-flow`, `compliance-flow`, `e-invoicing-flow`, `e-way-bills-flow` (in `apps/web/e2e/`).

## Previews

Screenshots of each module, taken from the running app with synthetic demo data, are in the project's `talk2tax-preview/` folder, under `tax/` (GST), `tds-tcs-rcm/`, `payroll/`, `compliance/`, `e-invoicing/` and `e-way-bills/`.

## Not in M3

What each module leaves out is listed in its own doc and in [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md). The largest gaps are:

* **Filing.** No connection to the GST portal, IRP, e-way bill portal, TRACES or the income-tax portal, and no return or statement files (GSTN JSON, Form 140/143, 24Q, ECR).
* **GST.** No imports of goods, SEZ supplies, composition scheme, ISD, blocked credits or ITC reversals, and no GSTR-2B matching.
* **Payroll.** No old tax regime, no professional tax outside Maharashtra, and no payroll approvals or reports beyond the run and the payslip.
* **Other countries.** Only India is covered; other countries' tax is planned for M8.
* **Expert review.** Payroll and the TDS/TCS templates should be checked by a practising professional before real use.
