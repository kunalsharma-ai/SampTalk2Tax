# Cash-flow forecast (M4, slice 2)

The cash-flow forecast shows the expected closing balance of the organisation's cash and bank accounts for each day ahead, over 30, 60, 90, 180 or 365 days. It shows a low and a high case beside the expected one, and warns when cash is expected to fall below a minimum balance.

Saved forecasts never change, so they can be measured against what really happened. A **backtest** rebuilds the forecast from the books as they stood on an earlier day and measures it the same way.

* **Rules:** `packages/accounting-engine/src/cashflow.ts`: payment delays, expected dates, planned dates, the daily series, the buckets and accuracy. It has no framework or database code.
* **API:** `apps/api/src/cash-flow`.
* **Web:**
  * **Planning → Cash-flow forecast**.
  * A page for each saved forecast or backtest, with its accuracy.

## How it works

1. **Opening cash.** The forecast starts from the balance of every cash and bank account (subtype CASH or BANK) at the end of the "as of" day. That day is today in India time by default. Only posted journals count.
2. **Open invoices and bills.** Each open sales invoice and purchase bill on that day is expected to be settled on its due date plus how late that contact usually pays.
   * **How late a contact pays** comes from the contact's invoices (or bills) fully settled in the year before the "as of" day: the number of days from the due date to the last payment. Paying early gives a negative number.
   * **Fewer than 3 settled documents for the contact:** everyone's history is used.
   * **Fewer than 3 for everyone:** the due date is used.
   * The forecast uses the median delay. The low and high cases use the 25th and 75th percentile.
   * An expected date is never earlier than the day after "as of". An invoice already later than the contact usually pays is marked **later than usual**.
   * **Doubtful:** an invoice more than 90 days overdue is counted only in the high case.
   * The open amount is what is left after payments, credit notes and withholding already allocated.
   * **Unapplied amounts:** receipts and payments not yet allocated to a document are shown under each list but are not added in, because it is not known what they will settle.
3. **Planned items.** These are receipts and payments the books do not hold yet: rent, salaries, loan instalments, tax, a signed contract not yet invoiced.
   * Each item happens once, every week, month, quarter or year, from a start date and optionally until an end date.
   * Monthly, quarterly and yearly items keep their day of the month, using the last day in a shorter month (31 Jan → 28 Feb → 31 Mar).
   * A paused item is left out.
   * Do not enter anything that is already an open invoice or bill: it would be counted twice.
4. **The three cases.**
   * **Expected (base):** every flow on its expected date. Doubtful invoices are left out.
   * **Low:** money in at the late date, money out at the early date, doubtful invoices left out.
   * **High:** money in at the early date, money out at the late date, doubtful invoices included.

   The band between low and high shows how much timing alone can move the balance. It is **not** a statistical confidence interval: it ignores amounts that may never be paid, apart from doubtful invoices, and spending that is not planned.
5. **Buckets.** Weekly up to 90 days and monthly beyond. Each bucket has the money in from customers, planned in, money out to vendors and planned out, the net, and the closing balance with its range.
6. **Minimum balance.** When it is set above zero, the page shows the first day the expected balance falls below it, or says that only the low case does.
7. **Saving and accuracy.**
   * **What is saved:** the daily series, the opening and closing, and a summary of the inputs.
   * **Accuracy:** for each day that has passed, the saved forecast is compared with the actual closing cash from posted journals. The page shows:
     * the days measured;
     * the **average miss**, the mean of |actual − expected|;
     * the **bias**, the mean of actual − expected (positive means cash came in higher than forecast);
     * the share of days the actual was **inside the range**;
     * the largest miss, and the day-by-day table.
8. **Backtests.** Pick an earlier "As of" date, up to 2 years back, and the forecast is rebuilt from the records as they stood on that day:
   * the documents issued by then, and their open amounts on that day (later payments and voids are ignored);
   * the payment history settled by then;
   * the cash on that day.

   **Planned items are today's**, because their history is not kept. A backtest saved this way is labelled as one, and the database checks the label.

## Permissions

| Action | Permission | Roles |
|---|---|---|
| See the forecast, planned items, settings and saved forecasts | `reports.read` | all roles except Employee |
| Add, change or remove planned items; set the minimum balance; save a forecast or backtest | `budgets.manage` | Owner, Admin, Accountant |

## Database guards

* Planned items: the amount is above zero, the end date is not before the start date, and a one-off item has no end date (CHECK).
* The minimum balance is not negative (CHECK).
* Saved forecasts:
  * the `days` array has exactly `horizon_days` entries;
  * `is_backtest` is true exactly when the "as of" date is before the day it was saved, in India time (CHECK);
  * a trigger refuses any **update or delete**.
* Row-level security applies as on every tenant table. Every change to items or settings, and every save, is in the audit trail.

## Not supported yet (do not rely on these)

* **Inputs.**
  * No sales pipeline.
  * No projection from recurring invoices, payroll runs, the GST and TDS calendar, or budgets: add these as planned items for now.
  * No seasonality or trend.
  * No machine learning.
* **Shape.**
  * One currency (the functional one), with all cash and bank accounts together.
  * No forecast per account or per bank.
  * No scenarios ("what if the big customer pays 30 days late").
  * No multi-year forecasts.
* **Range.** The low and high cases come from payment timing only (the 25th–75th percentile of delays). They are not a confidence interval and do not model customers who never pay, apart from the 90-day doubtful rule.
* **Backtests** use today's planned items, not the items as they were then.
* **No alerts** by email or notification, and no export.

## Tests

* `packages/accounting-engine/test/cashflow.test.ts` (6 tests):
  * delay percentiles;
  * expected dates, never before tomorrow, with the doubtful and later-than-usual flags;
  * planned dates, including month ends;
  * the three cases with doubtful invoices;
  * weekly and monthly buckets;
  * the minimum-balance day;
  * accuracy figures.
* `apps/api/test/cash-flow.e2e.test.ts` (10 tests):
  * planned items, with their checks and audit trail;
  * the minimum balance;
  * expected dates from a contact's own history, everyone's history and the due date;
  * a doubtful invoice;
  * the three cases, buckets, lowest point and warning, checked to the rupee;
  * 180-day monthly buckets;
  * refused horizons and dates;
  * a backtest rebuilt from the books 45 days ago;
  * saving a forecast and a backtest, and the backtest's accuracy against actual cash, day by day;
  * a saved forecast unchanged after the books change;
  * database tampering: update, delete, a mislabelled backtest and a zero amount;
  * tenant isolation.
* `apps/web/e2e/cash-flow-flow.test.mjs` (3 tests), in the browser:
  * adding a planned item, including an inline amount error, and the new closing balance;
  * the minimum-balance warning;
  * saving a forecast;
  * saving a backtest and opening its accuracy page.

The demo data has six planned items, a minimum balance, a term loan disbursement, a backtest from 30 days ago and a saved forecast. All of it is made up.
