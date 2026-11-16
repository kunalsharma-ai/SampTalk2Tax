# Business impact engine

The business impact engine shows what a change in sales, people, procurement or operations does to revenue, margins, profit and cash. You describe the business change in business terms. The engine turns it into figures from the organisation's own books and plays it forward from the posted months with the [digital twin](DIGITAL_TWIN.md), against the business carrying on as it is. Nothing is posted, paid or sent.

**Planning → Business impact** (`/orgs/:orgId/planning/impact`).

## The changes

Every change starts in a chosen month of the projection (month 1 is the current month). Each one becomes ordinary digital-twin changes, so the twin's model applies unchanged. Receivables and payables follow revenue and costs at the business's own collection and payment days, and income tax follows the rate in the books.

New revenue brings cost of sales at the business's own ratio: cost of sales over revenue in the baseline months (shown on the builder). The twin's expansion change gained an optional `costOfSalesPercent` for this. Without it, existing expansion scenarios work as before.

| Area | Change | Inputs | Becomes |
| --- | --- | --- | --- |
| Sales | **Win a new customer or contract** | Name, monthly sales at full speed, months to reach it | Revenue rising evenly to that figure, with cost of sales at the business's ratio |
| Sales | **Lose an existing customer** | A customer with sales in the baseline months | A permanent fall in volume equal to its share of revenue: its average monthly sales (revenue lines of posted invoices less credit notes, before tax) against baseline revenue. Its cost of sales goes too; payroll and running costs carry on |
| Sales | **Change prices** | Price change (%), change in sales volume (%) | The twin's price change. Price moves revenue only; volume moves revenue and cost of sales |
| Sales | **Add salespeople** | Number, monthly and one-off cost per person, monthly sales per person at full speed, months to reach it | A hire, plus revenue rising evenly with its cost of sales |
| Sales | **Change customer payment terms** | Days sooner or later | Longer or shorter collection days. Profit does not move; cash does |
| People (HR) | **Hire people** | Number, monthly cost each, one-off cost each | A hire: payroll from the start month, the one-off cost in running costs that month. No extra sales are assumed |
| People (HR) | **Pay rise** | Percentage | Payroll changes by that percentage |
| People (HR) | **Reduce headcount** | Number, monthly cost each, severance each | Payroll falls by their cost from the start month, and severance goes through profit that month. Refused when the people leaving cost more than the whole payroll |
| Procurement | **Supplier price change** | One supplier from the books, or all suppliers; percentage | Cost of sales changes by the percentage times the supplier's share of cost of sales (its average monthly bills before tax, against baseline cost of sales). For all suppliers, by the full percentage |
| Procurement | **Change supplier payment terms** | Days sooner or later | Longer or shorter payment days |
| Operations | **Open a site, branch or line** | Name, set-up cost, monthly running cost, monthly sales at full speed, months to reach it | The twin's expansion, with cost of sales on its revenue at the business's ratio |
| Operations | **Buy equipment or automation** | Name, cost, useful life, running costs saved a month | An investment paid in the start month and depreciated straight-line from the month after, and lower running costs from the month after |
| Operations | **Change running costs** | Percentage and/or an amount a month | Running costs other than payroll change |

Every input is checked, and problems are explained in words. For example: *Change 3: Useful life in months must be a whole number from 1 to 1200*. An assessment can hold up to 15 changes. Starting figures for a new change are sized to the books (for example, a new customer starts at about a tenth of monthly revenue). They are meant to be changed.

## What the assessment shows

* A **summary sentence**. For example: *These 3 changes together leave net profit INR 63000.00 higher over 6 months, with cash INR 41000.00 higher at the end. "Add 2 salespeople" moves profit most: INR 90000.00 higher on its own.* It also says when cash dips and when it is back level, or that cash runs out when it would not otherwise.
* Four figures: the change in net profit, in revenue (with the change in gross margin), in cash at the end (with payback), and the lowest cash.
* A chart of month-end cash: the actual months, then the projection carrying on as is and with the changes.
* **Before and after** totals over the horizon:
  * revenue;
  * gross profit and gross margin;
  * operating profit (gross profit less payroll, other running costs and depreciation) and operating margin;
  * net profit and net margin;
  * cash at the end;
  * lowest cash.

  Margin changes are in percentage points.
* **Each change, and how it reaches the figures**: the change on its own against carrying on as is. It shows how the change was worked out from the books, in words, and every line of the statements it moves over the horizon:
  * revenue, cost of sales and gross profit;
  * payroll, other running costs and one-off items;
  * depreciation, interest, income tax and net profit;
  * receivables and payables at the end;
  * money spent on equipment;
  * cash at the end.

  Each change also has its **payback**:
  * *no cash outlay*;
  * *pays back*, with the month cash is back level with carrying on as is;
  * *not paid back yet*, when cash is recovering but still behind at the end;
  * *cash stays lower*.
* **By business area**: each area's changes together, on their own. When changes in different areas affect each other, the difference between the combined effect and the sum of the areas is shown as **interaction**. For example, a supplier price rise costs more when volume is also rising. It is shown rather than hidden.
* **Month by month**: revenue, net profit and month-end cash with the changes, next to carrying on as is.
* **Assumptions**:
  * the baseline months;
  * the cost of sales ratio;
  * the payment days;
  * the tax rate;
  * that every projected figure is hypothetical.

## Saving, and the war room

People who manage scenarios (`scenarios.manage`) can save an assessment. It is numbered BI-0001, BI-0002 and so on.

* Only the changes are stored. Every visit re-runs them on the books as they stand.
* If a customer or supplier it names has left the books, the page explains what needs fixing instead of failing.
* **Open as a twin scenario** copies the twin changes into a new [digital-twin scenario](DIGITAL_TWIN.md), so the plan can go through the [war room](WAR_ROOM.md) for approval.

## API

| Endpoint | Permission | Purpose |
| --- | --- | --- |
| `GET /v1/orgs/:orgId/impact/options?baselineMonths=&horizonMonths=` | reports.read, sales.read, purchases.read | Areas and levers, monthly averages, the cost of sales ratio, customers with sales and suppliers with bills |
| `POST /v1/orgs/:orgId/impact/assess` | same | Runs `{ baselineMonths, horizonMonths, changes }` without saving |
| `GET /v1/orgs/:orgId/impact/assessments` (+ `/:id`) | same | Saved assessments, re-run |
| `POST`, `PUT`, `DELETE …/impact/assessments[/:id]` | scenarios.manage | Save, change, delete (audited) |
| `POST …/impact/assessments/:id/scenario` | scenarios.manage | Copy to a digital-twin scenario (audited) |

## Limits

* The figures are for the whole organisation. Customer and supplier shares are averages over the baseline months.
* A new customer pays in the business's usual days, and new revenue carries the business's average cost of sales ratio. Enter a separate change if a contract's margin or terms differ.
* A headcount reduction assumes sales do not change. If the people leaving bring in sales, add that loss as a separate change.
* There is one deterministic path per assessment, not a range of outcomes.
