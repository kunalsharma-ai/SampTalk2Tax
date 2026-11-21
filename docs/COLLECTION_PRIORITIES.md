# Collection priorities (AR-034)

Sales → Collection priorities ranks the customers to chase today, suggests how to chase each one,
and shows the points behind every score. It is worked out from the books, open disputes, sent
reminders and the payment predictions (see PAYMENT_PREDICTIONS.md). No AI model is used, so the
same books always give the same ranking.

## Who is listed

A customer with an overdue balance, or with an invoice due in the next 7 days that is at least as
likely as not to be paid late. Customers with nothing to chase are left out.

## Score (0 to 100)

| Factor | Points |
| --- | --- |
| Money to chase: overdue and not disputed, against the largest such amount of any customer | up to 40 |
| Age of the oldest overdue invoice: over 90 days 25, over 60 20, over 30 15, any 8 | up to 25 |
| Chance of paying late, from the payment predictions, weighted by amount | up to 20 |
| An invoice due in the next 7 days likely to be late | 5 |
| Not contacted lately: no reminder in 14 days 10, in 7 to 14 days 5, in 7 days 0 | up to 10 |

Ties go to the larger amount to chase, then the name.

## Suggested action

- **Settle the dispute first**: everything overdue is in an open dispute.
- **Reminded lately: give it a few days**: a reminder was sent in the last 7 days.
- **Call, and consider a credit hold**: over 60 days past due (just **Call** when already on hold).
- **Call the customer**: over 30 days past due.
- **Send a reminder**: past due up to 30 days.
- **Send a friendly note before it is due**: nothing overdue, but an invoice due this week is likely late.

Reminders are drafted and sent from Sales → Collections.

## API

`GET /v1/orgs/:orgId/collection-priorities` needs `reports.read`. Read-only.

Code: `packages/accounting-engine/src/collection-priorities.ts`,
`apps/api/src/payment-predictions/collection-priorities.service.ts`,
`apps/web/src/app/orgs/[orgId]/sales/collection-priorities/page.tsx`.
Tests: `packages/accounting-engine/test/collection-priorities.test.ts`,
`apps/api/test/collection-priorities.e2e.test.ts`, `apps/web/e2e/collection-priorities-flow.test.mjs`.
