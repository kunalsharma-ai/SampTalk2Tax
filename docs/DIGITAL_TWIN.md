# Financial digital twin (M7 slice 1)

The digital twin plays "what if" changes forward from an organisation's actual books, month by month, and shows what they would do to profit and cash. It is a planning tool only: scenarios are stored as their inputs, every result is worked out again when it is opened, and **nothing is ever posted to the ledger** (Directive Part 15).

Pages: **Planning → Digital twin** (`/orgs/:orgId/planning/twin`), a scenario page (`/planning/twin/:id`), a new-scenario page that can start from a template (`/planning/twin/new?template=HIRE`), and a comparison page (`/planning/twin/compare?ids=…`). Working a scenario as a team (impacts, suggestions, notes, versions and approval) is described in [`WAR_ROOM.md`](WAR_ROOM.md).

## The baseline

The baseline is the average of the last 3, 6 or 12 **complete** months of posted journals, read through the same month figures as the KPIs page (`KpisService.monthFigures`):

| Figure | From |
|---|---|
| Revenue, other income | Revenue and other income accounts |
| Cost of sales | Cost of sales accounts |
| Payroll | Payroll and salary expense accounts |
| Other operating costs, other expenses | The remaining expense accounts |
| Depreciation, interest, income tax | Their own account types |
| Cash, receivables, payables | Balances at the end of the last month (not averaged) |

From these the twin works out how many days customers take to pay (receivables ÷ revenue × 30) and how many days suppliers are paid in (payables ÷ (cost of sales + operating costs) × 30). The income tax rate comes from a tax-rate change in the scenario if there is one, else from the history (tax ÷ profit before tax, when both are positive), else it is zero and the twin asks for it.

With no changes the projection is the business as it is now: the baseline month repeated across the horizon.

## Changes (drivers)

A scenario holds up to 50 changes of 15 kinds. Months are counted from 1 (the first month after the last actual month), and each change applies from its month to the end of the horizon unless it says otherwise.

| Change | Inputs | Effect |
|---|---|---|
| Revenue growth | % per month, from month | Volume compounds monthly |
| Price change | price %, volume %, from month | Revenue moves with price × volume; cost of sales follows volume only |
| Customer churn | % lost per month, from month | Volume shrinks, compounding |
| Hiring | people, monthly cost each, one-off cost each, from month | Payroll from the month; the one-off cost goes through profit in that month |
| Expense change | operating costs, payroll or cost of sales; % and/or monthly amount | Applied to that group |
| Supplier costs | % | Cost of sales per unit of volume |
| New loan | amount, interest % a year, term | Received in its month, repaid by EMI from the next; interest through profit, principal through cash |
| Investment | amount, useful life | Paid in its month, depreciated straight-line from the next |
| Expansion | one-off cost, monthly cost, revenue at full speed, months to full speed | Revenue ramps evenly to full speed. An optional cost of sales share (%) books cost of sales on that revenue; the [business impact engine](BUSINESS_IMPACT.md) sets it to the business's own ratio |
| Exchange rate | share of revenue in foreign currency, rate change % | That share of revenue is worth more or less |
| Cost inflation | % a year | All costs compound monthly |
| Market downturn | revenue drop %, extra days to pay, from month, for how many months | Revenue drops and customers pay later, then recover |
| Payment terms | customers' and suppliers' days later or sooner | Moves receivables and payables, and so cash |
| Income tax rate | % | Tax on positive profit before tax; losses get no relief |
| One-off item | what it is, amount (+ in, − out), month, through profit or not | A single cash amount, and in profit if ticked |

Every input is checked by the engine with an explanation in words (for example "Change 1: People hired must be a whole number from 1 to 10000"); the API turns these into a 422 with the list of issues.

## The projection

For each month: revenue, other income, cost of sales, gross profit, payroll, other operating costs, other expenses, EBITDA, depreciation, interest, profit before tax, tax, net profit, receivables, payables, the change in working capital, investment, loan received and repaid, one-off cash, cash flow and cash at the end. Totals give revenue, EBITDA, net profit, net margin and cash flow over the horizon, plus:

* **Lowest cash** and the month it happens.
* **The month cash runs out**, if it does.
* **Cash to raise**: how much more is needed to stay at or above the minimum balance set on the cash-flow forecast page (zero when no minimum is set).
* **Break-even month**: the first month net profit turns positive when the scenario starts loss-making.

All money is decimal (decimal.js), rounded half up to the currency's minor units at each month; floats are used only to place points on the chart.

## Risks, missing inputs and assumptions

* **Key risks** (High, Medium or Low): cash runs out (with the amount to raise), cash falls below the minimum balance, a loss over the horizon, ending loss-making while profitable overall, gross margin under 10%, receivables growing, operating profit covering loan payments less than 1.25 times, and a history shorter than three months.
* **Inputs to confirm** ask questions where the scenario is missing something: no tax rate, no revenue in the baseline, no inflation over more than 12 months, and no investment when five or more people are hired. Where a change answers the question, an **Add** button adds it.
* **Assumptions** describe every baseline figure and every change in words, so the scenario can be read without opening each card.

## Templates

Nine starting points with placeholder figures to adjust: Hire a team, Raise prices, Market downturn, Take a term loan, Open a new location, Supplier price rise, Losing customers, Home currency strengthens, Collect faster. They are fixed in the engine (`TWIN_TEMPLATES`), not generated by AI.

## Keeping hypothetical figures apart

* Scenarios live only in `twin_scenarios`, as inputs (name, description, baseline months, horizon, changes). There are no projected rows anywhere and no journal is ever written; the API and browser tests count journals before and after.
* The chart draws actual months as a solid line and every projection dashed over a shaded band labelled "Hypothetical"; the page carries a "Hypothetical figures" banner and the table is titled "Projection by month (hypothetical)". Every chart has the figures in a table beside it.
* The cash-flow forecast (from open invoices and bills) stays on its own page; the twin works from averages and does not overlay it.

## Comparing

Up to five saved scenarios side by side with "No change (baseline)", all run on the same baseline and horizon (the largest baseline and the longest horizon of those chosen): revenue, net profit, margin, cash at the end, lowest cash, cash to raise and the number of high risks, with the most profitable marked, and a chart of month-end cash for each.

## API

All under `v1/orgs/:orgId/twin`. Reading needs `reports.read`; saving, changing and deleting scenarios needs `scenarios.manage` (owners, admins and accountants).

| Method and path | Purpose |
|---|---|
| `GET templates` | The nine templates |
| `GET baseline?baselineMonths=3\|6\|12&horizonMonths=1..60` | Actual months and the no-change projection |
| `POST simulate` `{ baselineMonths, horizonMonths, drivers }` | Runs changes without saving |
| `GET scenarios`, `POST scenarios` | List and create (`name` unique per organisation; 409 if taken) |
| `GET/PUT/DELETE scenarios/:id` | Read (with the result and the baseline projection), change, delete |
| `GET compare?ids=a,b` | Up to five scenarios and the baseline |

Creating, changing and deleting are audited as `twin_scenario.created`, `.updated` and `.deleted`.

## Limitations

* The model is a monthly driver model on averages: no seasonality, no per-customer or per-product detail, no balance sheet beyond cash, receivables and payables, and no GST/VAT cash timing.
* Tax is a flat rate on positive monthly profit, with no relief for losses and no advance-tax timing.
* Loans are EMI only; investments depreciate straight-line with no disposal.
* Templates are fixed placeholders; there is no AI-written scenario or narrative yet.
* Scenarios are re-run against the latest actuals each time, so an old scenario's figures change as the books do; there is no snapshot of a past run.
