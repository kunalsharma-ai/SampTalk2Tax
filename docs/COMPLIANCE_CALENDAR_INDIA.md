# Compliance calendar: India (M3, slice 4)

A calendar of the returns and payments an organisation in India owes, worked out from its own set-up and settled from its own records.

* **Rules:** `packages/tax-engine/src/india/calendar.ts`, function `complianceObligations`. Each rule carries its source, which the page shows.
* **API:** `apps/api/src/compliance`, which adds the status of each item from the books.
* **Web:** **Tax → Compliance calendar**, plus a card on the dashboard.

## What it does

* **What applies, and from when:**
  * **GST.** Applies from the registration's effective date. Monthly filers get GSTR-1 on the 11th and GSTR-3B on the 20th of the next month. QRMP filers get:
    * GSTR-1 on the 13th after the quarter;
    * GSTR-3B on the 22nd (Chhattisgarh, MP, Gujarat, Maharashtra, Karnataka, Goa, Kerala, Tamil Nadu, Telangana, AP and the western/southern UTs) or the 24th (other states) after the quarter;
    * PMT-06 on the 25th for the first two months of each quarter.

    For both, GSTR-9 is due on 31 December after the financial year.
  * **TDS/TCS.** Applies from the TAN set-up date, or the first document with TDS or TCS if that is earlier.
    * Monthly TDS and TCS deposits are due on the 7th of the next month, or 30 April for March.
    * Quarterly statements are due on 31 July, 31 October, 31 January and 31 May: Form 140 (TDS for residents, was 26Q) and Form 143 (TCS, was 27EQ).
  * **Payroll.** Applies from the payroll set-up date or the first pay run.
    * PF and ESI are due on the 15th of the next month.
    * Maharashtra professional tax is due at the end of the next month, but only when an employee works there.
    * TDS on salary is deposited with the monthly TDS deposit.
    * Form 138 (was 24Q) is due each quarter.
  * **Advance tax.** When switched on in the calendar settings: 15 June, 15 September, 15 December and 15 March.
* **Status of each item:**
  * **Payments** are settled by records, never by hand.
    * A TDS deposit is done when every bill or invoice with TDS in the month is on a deposited challan *and* the month's payroll TDS is paid.
    * TCS works the same way with invoices.
    * PF, ESI and PT are done when the pay run's payment is recorded.
    * The item shows the amount, what has been paid and what is left, with links to the challans, pay runs and payroll payments.
    * "Nothing due" means nothing was deducted or collected in the period.
    * "No pay run posted" flags a month with payroll set up but no run.
  * **Returns** (GSTR-1, GSTR-3B, PMT-06, GSTR-9, Forms 138/140/143) and **advance tax** are done when marked filed or paid, with the date and the ARN, token or challan.
    * A filing record is never edited. It can only be voided once, with a reason, which a database trigger enforces.
    * One record can stand per obligation at a time, enforced by a partial unique index.
  * **Open items** are *overdue* after the due date, *due soon* within 7 days, and *upcoming* otherwise.
  * The calendar also lists items still overdue from up to two years before the window being viewed.

## Not supported yet (do not rely on these)

* **Holidays and extensions.** Dates are not moved for holidays, and extensions announced by CBIC or CBDT notification are not applied.
* **GST:**
  * The GST frequency is one setting for all periods; a change between QRMP and monthly filing during the year is not modelled.
  * No composition (CMP-08, GSTR-4), ISD, TDS/TCS under GST (GSTR-7/8), GSTR-9C applicability by turnover, or e-way bills.
  * Paying GST is not tracked separately from filing GSTR-3B or PMT-06.
* **Income tax:**
  * No Form 144 (TDS for non-residents, was 27Q), certificates (Forms 130/131/133), or the income-tax return and tax audit dates.
  * The advance tax amount is not calculated.
* **Other states and laws.** No professional tax for states other than Maharashtra, no labour welfare fund, and no ROC/MCA filings.
* **Delivery.** No reminders by email or notification.
* **Filing.** Nothing is filed: TAX-027 requires an approved integration for that.

## Sources (checked 2026-11-01)

* **GST:** CGST Act 2017 s.37, s.39 (including the QRMP proviso to s.39(1) and s.39(7)) and s.44, and CGST Rules 59, 61 and 80. The QRMP state groups are as published for the 22nd/24th GSTR-3B dates. These were checked against a 2026-27 compliance calendar (incorpx.io); the GSTN advisories themselves were not reachable from here.
* **TDS/TCS:**
  * Income-tax Act 2025 s.397(3)(b) and Income-tax Rules 2026 rule 219.
  * Forms 138/140/143/144 replace 24Q/26Q/27EQ/27Q from tax year 2026-27, per taxupdate.in (July 2026) and taxguru.in (July 2026). These are secondary sources.
  * The TCS statement date of 31 July for Q1 (formerly 15 July) is from the same sources and needs confirming against the Rules.
* **Payroll:** EPF Scheme 1952 para 38, ESI (Central) Regulations reg. 31, and the Maharashtra Profession Tax Rules.

## Tests

* `packages/tax-engine/test/calendar.test.ts` (8 tests): monthly and QRMP GST, GSTR-9, deposits including March, statement dates, payroll with and without Maharashtra, one TDS deposit when payroll and a TAN both apply, applicability start, advance tax, and statuses.
* `apps/api/test/compliance.e2e.test.ts` (11 tests):
  * GST and QRMP dates.
  * Marking filed: duplicates, payments, unknown keys and dates are refused.
  * Void and re-file; immutability in the database.
  * TDS combining a bill and payroll, partly then fully paid; PF, ESI and PT; advance tax; overdue carry-forward.
  * Viewer and tenant isolation.
* `apps/web/e2e/compliance-flow.test.mjs` (4 tests): in the browser, the empty state, then GST returns, marking filed and voiding, switching to QRMP, and the dashboard card.
