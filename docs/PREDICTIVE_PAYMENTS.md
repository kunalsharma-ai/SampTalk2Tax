# Predicted payment dates (AP-034)

Purchases → Payment schedule → Predicted payment dates suggests a payment date for each open bill
over the next 30, 60 or 90 days, from the cash in the bank now and when customers are expected to
pay their open invoices (the AR-033 payment predictions). The balance never goes below the amount
you choose to keep in the bank. Nothing is paid here and no AI model is used; the logic is in
`packages/accounting-engine/src/predictive-payments.ts`.

## How the dates are worked out

- The cash starts at the balances of the active bank accounts today. Bills already in an open
  payment batch come off today.
- Each open invoice's outstanding amount comes in on its predicted payment date (today, if that
  date has passed).
- Bills are taken by due date (overdue ones first), then by their priority score (AP-030).
- A bill is paid on its due date (today, if it is overdue) when the balance stays at or above the
  amount to keep on that day and every day after it. Otherwise it waits for the first later day when
  it does, and the reason names the receipt it waits for. A bill no day in the period can cover is
  shown as not covered.
- Bills due after the period, and bills whose vendor has no verified bank details, are listed but
  not given a date.

The weekly table shows the receipts expected, the suggested payments and the balance at the end
of each week.

## Planning the dates

"Plan these dates" (or "Plan" on one row) writes the suggested dates into the payment schedule
(AP-007) as payment plans with the note "Predicted date (AP-034)", checked as any plan is (not in
the past, not before the bill date). Each one is recorded in the audit trail as
`bill_payment.predicted_planned`. A payment batch can then be prepared from the schedule as usual.

## API

- `GET /v1/orgs/:orgId/purchases/payment-schedule/predicted?days=30|60|90&buffer=` (reports.read)
- `POST /v1/orgs/:orgId/purchases/payment-schedule/predicted/apply?days=&buffer=` with
  `{ "documentIds": [...] }` (optional; all suggested dates when left out) (purchases.manage)

## Limits

Receipts are the predicted dates of open invoices only; other income and spending (salaries, rent,
taxes) are not forecast here. See the Bank cash forecast (BANK-022) and the Cash-flow forecast for
those. Only bills in the organisation's own currency are scheduled.
