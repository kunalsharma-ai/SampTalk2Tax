# Suggested payment plans (AR-040)

Sales → Payment plans suggests an instalment plan for each customer who is behind on paying, lets a
member who manages collections agree one, and shows how every agreed plan is going. A plan does not
change the invoices or the books: the invoices stay owed in full until receipts are recorded
against them as usual.

## The suggestion

- It covers the customer's posted invoices past their due date that have no open dispute. Disputed
  invoices are listed as left out: settle the dispute first.
- Instalments: the overdue amount ÷ the customer's average monthly receipts over the last 6 months
  (180 days ÷ 6), rounded up, between 2 and 12. With nothing received in that time, 3. With an
  invoice more than 90 days overdue, at most 6, so old debt is not stretched further.
- The first instalment is due in 7 days, or on a chosen date in the next 60 days; the rest on the
  same day of each following month (the month's last day when it is shorter).
- Instalments are equal, rounded down to the currency's minor unit; the last takes the rounding.
- Every suggestion lists the reasons for its length. Options of 2, 3 and 6 instalments are shown
  beside the suggested one.

Amounts are in the functional currency; foreign-currency invoices and receipts are converted at
their own exchange rates. Customers with a running plan are not offered another.

## Agreeing a plan

`POST /v1/orgs/:orgId/payment-plans` with `contactId`, `instalments` (1 to 12), `firstDueDate` and an
optional `note` (needs `collections.manage`). The invoices and amounts are worked out on the server
from what the customer owes that day; the request cannot set them. A customer can have one running
plan at a time. The plan keeps the invoices, what each owed, the schedule and the suggested number
of instalments.

## Progress

Money received against the plan's invoices since it was agreed (what each owed then, less what it
owes now; an invoice no longer open owes nothing) pays the instalments in order.

| Status | When |
| --- | --- |
| On track | Every instalment due so far is paid |
| Behind | An instalment past its date is not fully paid |
| Broken | An instalment is more than 7 days past its date and not fully paid |
| Completed | Everything on the plan is paid |
| Cancelled | Cancelled with a reason |

## Records

Plans are stored in `payment_plans`. An agreed plan's invoices, schedule and note never change; it
only changes by being cancelled (who, when and why), a cancelled plan is kept as it was, and plans
are never deleted. Agreeing and cancelling are written to the audit trail (`payment_plan.agreed`,
`payment_plan.cancelled`).

## API

- `GET /v1/orgs/:orgId/payment-plans`: plans with progress, customers to offer a plan with their
  suggestion, and a summary (needs `sales.read`).
- `GET /v1/orgs/:orgId/payment-plans/suggest?contactId=&instalments=&firstDueDate=`: one customer's
  suggestion with an optional choice.
- `GET /v1/orgs/:orgId/payment-plans/:id`, `POST /v1/orgs/:orgId/payment-plans/:id/cancel` with a
  `reason`.

The logic is in `packages/accounting-engine/src/payment-plans.ts`; no AI model is used.
