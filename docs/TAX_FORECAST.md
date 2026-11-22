# Tax liability forecast (TAX-048)

Tax → **Tax forecast** (`/tax/forecast`): the tax payments due in the coming months (1 to 6), and what each is likely to be.

## What is forecast

Every payment the [compliance calendar](COMPLIANCE_CALENDAR_INDIA.md) expects in the window that is not yet settled, including overdue ones: GSTR-3B (or PMT-06 under QRMP), TDS and TCS deposits, PF, ESI, professional tax and advance income tax.

## How each amount is worked out

`taxLiabilityForecast` in `packages/tax-engine/src/india/tax-liability-forecast.ts`:

- **From the books** (the period is over):
  - GST: what the GST payment preview leaves after input credit set-off as of the month end. GST owed is one running balance, so only the latest unpaid return carries it, and it names the earlier unpaid months it includes.
  - TDS/TCS: deducted or collected on documents and not deposited.
  - PF, ESI, PT and salary TDS: on a posted pay run and not paid.
- **From the advance tax plan**: the instalment's amount still to pay.
- **Recent average** (the period has not ended): the average of the last three periods. For GST, each month's cash after set-off is worked out from its documents as GSTR-3B would; months before anything was recorded are left out. The likely range is one standard deviation of the last six periods, never below zero. Under QRMP, the quarter's GSTR-3B is forecast for its last month only, because PMT-06 pays the first two.
- **No history yet**: shown at zero, saying so.

Totals are given per month of the due date, with the part already known. All arithmetic is decimal. Nothing is paid or filed; no AI model is used.

## API

`GET /v1/orgs/:orgId/tax-forecast?months=1..6` (default 3), permission `reports.read`. Indian organisations only (422 `NOT_INDIA`).

## Tests

- `packages/tax-engine/test/tax-liability-forecast.test.ts`
- `apps/api/test/tax-forecast.e2e.test.ts`
- `apps/web/e2e/tax-forecast-flow.test.mjs`

## Not built

Interest and late fees on overdue payments, GST on sales orders or recurring invoices not yet issued, and income tax beyond advance tax (self-assessment tax).
