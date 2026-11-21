# Collection forecast (AR-039)

Sales → Collection forecast shows the money expected from customers week by week (4, 8, 13 or 26
weeks from today), from when each open invoice is predicted to be paid (see PAYMENT_PREDICTIONS.md),
beside what the due dates alone would say.

- **Expected**: each open invoice's outstanding amount in the week of its predicted payment date.
- **By due date**: the same amount in the week it falls due; anything already overdue counts in the
  first week. Where Expected trails By due date, customers are paying later than their terms.
- **Later**: predicted after the last week shown.
- **Doubtful**: invoices over 90 days past due (the same cut-off as the cash-flow forecast), left
  out of the weeks.
- **Prediction accuracy**: the average miss in days of the same predictions on invoices paid in
  the last year.

Amounts are decimals in the functional currency. Invoices are only forecast once some invoice has
been paid in full (the predictions need history). The cash-flow forecast adds bills, planned
receipts and payments for the full cash position.

## API

`GET /v1/orgs/:orgId/payment-predictions/forecast?weeks=13` (1 to 26) needs `reports.read`.
Read-only.

Code: `packages/accounting-engine/src/collection-forecast.ts`,
`apps/api/src/payment-predictions/payment-predictions.service.ts` (`forecast`),
`apps/web/src/app/orgs/[orgId]/sales/collection-forecast/page.tsx`.
Tests: `packages/accounting-engine/test/collection-forecast.test.ts`,
`apps/api/test/payment-predictions.e2e.test.ts`, `apps/web/e2e/collection-forecast-flow.test.mjs`.
