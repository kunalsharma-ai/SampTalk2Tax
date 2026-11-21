# Payment predictions (AR-033)

Sales → Payment predictions scores every open invoice: the day it is likely to be paid, how many
days after the due date that is, the chance it is paid late, how confident the prediction is, and
the reasons. It works only from the organisation's own books, with no AI model, so the same books
always give the same answer.

## How a prediction is made

- **The customer's record.** Each invoice the customer has paid in full: days from the due date to
  the day the last receipt or credit was applied (0 when paid early). Up to five days after the due
  date counts as on time; over 30 days is very late. A payment half a year old counts half as much
  as one made today; payments over two years old are left out.
- **Little history.** The organisation's average (every customer's paid invoices, weighted the
  same way) counts as three paid invoices beside the customer's own. A customer with no paid
  invoices uses the organisation's average alone. Confidence: high with six or more paid invoices,
  medium with three to five, low with one or two.
- **A change lately.** When the customer's last 90 days are a week or more slower (or faster) than
  before, the estimate moves by half the change.
- **Overdue now.** An invoice already past due is late for certain and is expected at least a week
  from today. When another invoice of the same customer is more than 30 days overdue, the chance of
  being late is at least 80%.

Nothing is scored until some invoice has been paid in full.

## Summary

- Expected in the next 30 days: the outstanding amount of invoices predicted to be paid by then.
- Likely to be late: each invoice's outstanding amount times its chance of being late.
- Amounts are in the functional currency, in decimals.

## Accuracy

Every invoice paid in the last year (at most the latest 500) is predicted again from only what was
known on its issue date, and compared with when it was actually paid: the average miss in days, the
share within a week, and the share in the right band.

## API

`GET /v1/orgs/:orgId/payment-predictions[?contactId=…]` needs `reports.read`. Read-only.

Code: `packages/accounting-engine/src/payment-predictions.ts`,
`apps/api/src/payment-predictions/`, `apps/web/src/app/orgs/[orgId]/sales/payment-predictions/`.
Tests: `packages/accounting-engine/test/payment-predictions.test.ts`,
`apps/api/test/payment-predictions.e2e.test.ts`, `apps/web/e2e/payment-predictions-flow.test.mjs`.
