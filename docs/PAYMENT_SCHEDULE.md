# Payment schedule

Registry: **AP-007 Payment scheduling**.

The payment schedule says when each open bill will be paid, and shows what those payments leave
in the bank week by week, so a week that would overdraw is seen before it comes. A plan moves no
money and posts nothing: bills are paid by a payment batch (see [PAYMENT_BATCHES.md](PAYMENT_BATCHES.md))
or a payment recorded by hand.

## Planning a bill

**Purchases → Payment schedule** lists every posted bill in the functional currency with something
left to pay: planned bills first by date, then the rest by due date.

* **Plan…** sets the date to pay and, to pay only part, the amount. The date cannot be in the past
  or before the bill date, and the amount cannot be more than is left. A note can say why (for
  example, the rest is held over a dispute).
* A bill page has **Plan payment…**, which opens the same dialog.
* **Plan the rest** plans every bill without a plan for its suggested date: the due date or, when
  **We pay on** is set to a weekday, the last such day on or before the due date. A bill already
  overdue, or due before the next pay day, is suggested for today (or the next pay day if it is
  already overdue). The pay day is remembered in this browser.
* A plan dated after the due date is marked *After due date*; one whose date has passed without the
  bill being paid is marked *Date passed*.
* As payments are recorded the plan follows: a part-paid bill pays at most what is left, and a paid
  bill leaves the schedule.

## Cash by week

Starting from the bank and cash accounts' balance in the ledger today, each row is a week (Monday to
Sunday) with the payments planned in it and the balance after them. A plan dated before this week
counts in this week. A week whose balance goes below zero is marked **Short**. Money coming in is
not counted here; the cash-flow forecast (see CASH_FLOW_FORECAST.md) does that.

## From plan to batch

Choose **Bills planned up to** a date and press **Prepare batch**: a new payment batch opens with
those bills ticked at their planned amounts, dated the latest planned date. Bills already in an
open batch are left out, and the schedule shows which batch each bill is in.

| Action | Permission |
| --- | --- |
| See the schedule | `purchases.read` |
| Plan, change, remove a plan, plan the rest | `purchases.manage` |

## API

Under `/v1/orgs/:orgId/purchases/payment-schedule`:

| Method | Path | |
| --- | --- | --- |
| GET | `/?weeks=8&payWeekday=5` | open bills with plans and suggestions, cash, weeks, totals |
| PUT | `/bills/:documentId` | `{ payDate, amount?, note? }` |
| DELETE | `/bills/:documentId` | remove the plan |
| POST | `/auto` | `{ payWeekday?, documentIds? }` plan the unplanned bills |

## Not yet

* Bills in a foreign currency.
* Early-payment discounts and paying by priority (AP-029, AP-030).
* Receipts in the weekly view (they are in the cash-flow forecast).
