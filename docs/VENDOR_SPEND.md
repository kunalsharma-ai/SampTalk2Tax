# Vendor spend

Reports → **Vendor spend** (RPT-016) shows what the organisation bought in a period, from whom and on what, compared with the same number of days just before.

## What counts

- Posted bills, before tax, less posted vendor credits. Drafts and voided documents are left out.
- Each line is converted at its own document's exchange rate and rounded to the functional currency, so totals add up line by line. All amounts are decimals.
- The period before is the same number of days ending the day before the chosen start.

## What it shows

- **Spend by vendor**: amount, share of the total, number of bills, the period before and the change. Concentration is shown as the number of vendors, from the largest, that make up 80% of the spend.
- **Spend by account**: the expense and asset accounts the bills were coded to, with their share.
- **Spend by month**: the total for each calendar month in the period.

## Access

`GET /v1/orgs/:orgId/reports/vendor-spend?from=&to=` needs both `reports.read` and `purchases.read`.

## Code and tests

- `packages/accounting-engine/src/vendor-spend.ts` (`buildVendorSpend`, `previousPeriod`) and `test/vendor-spend.test.ts`
- `apps/api/src/reports/reports.service.ts` (`vendorSpend`) and `apps/api/test/vendor-spend.e2e.test.ts`
- `apps/web/src/app/orgs/[orgId]/reports/vendor-spend/page.tsx` and `apps/web/e2e/vendor-spend-flow.test.mjs`
