# US 1099s and state sales tax returns (TAX-029)

Tax → **US 1099s and state returns**, for organisations in the United States.

## Federal: Forms 1099-NEC and 1099-MISC

For a calendar year, every vendor paid from a bank or cash account gets a row saying whether a 1099 is due and why:

| Decision | When |
| --- | --- |
| File a 1099 | Paid at or above the threshold, with a W-9 on record. Services go on 1099-NEC box 1, rents on 1099-MISC box 1, prizes and awards on 1099-MISC box 3. |
| Get a W-9 | Paid at or above the threshold, with no W-9 (or no taxpayer number) on record. |
| Below the threshold | Paid less than the threshold in the year. |
| Corporation, not reported | C or S corporation, or an LLC taxed as one, unless the payments are for legal services. |
| Exempt payee | The W-9 certifies an exempt payee. |
| Goods, not reported | The vendor is paid for goods, merchandise, freight or storage. |
| Outside the US, 1042-S instead | The vendor's country is not the US. |

- Threshold: $600 for payments through 2025, $2,000 for payments made from 2026 (One Big Beautiful Bill Act, 2025; indexed for inflation after 2026). Due dates: 1099-NEC to vendors and the IRS by 31 January; 1099-MISC to vendors by 31 January and the IRS by 28 February on paper or 31 March electronically, moved to Monday when they fall on a weekend. Ten or more returns must be filed electronically.
- Voided payments are left out. Company card spending is not a vendor payment in Talk2Tax and is reported by the card company on Form 1099-K.
- W-9 details: classification, SSN or EIN, **only the last four digits** of the number (never the full number, and not even those in the audit trail), the date received, what the vendor is paid for, and whether it is for legal services.
- The CSV export (for filing software) is recorded in the audit trail.

## State: sales tax returns

For each state permit recorded on US sales tax (TAX-028), the returns its filing frequency calls for in the year (monthly, quarterly or annual), with the net sales, tax charged and invoices to customers in that state in each period. Periods before the permit took effect are left out or shortened.

## Not covered

Backup withholding, Form 1042-S, Form 1096, state 1099 filing (Combined Federal/State Filing), state due dates, holidays moving a due date, and filing with the IRS or any state.

**The rules above were written from IRS instructions as known on 24 November 2026 and need review by a US tax adviser before anyone relies on them.**

## Evidence

- Engine: `packages/tax-engine/src/us/information-returns.ts`, tests `packages/tax-engine/test/us-information-returns.test.ts`
- Data: `us_vendor_tax_profiles` (migration `20270312100000_us_vendor_tax_profiles`)
- API: `GET /v1/orgs/:orgId/tax/us-reporting?year`, `GET .../1099/export?year`, `PUT|DELETE .../vendors/:contactId`; tests `apps/api/test/us-reporting.e2e.test.ts`
- Web: `apps/web/src/app/orgs/[orgId]/tax/us-reporting/page.tsx`; browser test `apps/web/e2e/us-reporting-flow.test.mjs`
