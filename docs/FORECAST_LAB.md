# Forecast evaluation lab

The forecast evaluation lab answers one question: **which simple forecasting method would have forecast this business best?** It tests eight methods on the organisation's own posted books and ranks them. It also keeps saved forecasts so their accuracy can be measured once the months are over.

**Planning → Forecast lab** (`/orgs/:orgId/planning/forecast-lab`).

## What is forecast

Five monthly figures, each taken from the posted books by the same month figures the KPIs page uses:

| Figure | From the books |
| --- | --- |
| Revenue | Operating revenue posted in the month |
| Cost of sales | Cost of sales posted in the month |
| Operating expenses | Operating expenses, payroll and depreciation |
| Net income | Revenue and other income less every expense |
| Net cash flow | Change in cash and bank balances during the month |

The history is the last **complete** month and up to 35 months before it. Leading months with nothing posted are left out, so a business that started a year ago has a year of history, not three.

## The methods

| Method | Needs | Forecast |
| --- | --- | --- |
| Last month | 1 month | The last month repeated |
| 3-month average | 3 | Average of the last 3 months |
| 6-month average | 6 | Average of the last 6 months |
| 12-month average | 12 | Average of the last 12 months |
| Same month last year | 12 | The same calendar month a year earlier |
| Last month plus trend | 6 | The last month plus the average monthly change over up to 12 months, times the months ahead |
| Straight-line trend | 6 | A least-squares line through up to 12 months, extended |
| Exponential smoothing | 3 | A weighted average where each older month counts 30% less (α = 0.3) |

All arithmetic is decimal. Results are rounded to the currency's minor unit (half-even) only at the end.

## How the methods are tested

The lab uses a **rolling-origin backtest**. Choose how many of the latest months to check: 6, 12 or 18. For every checked month and for 1, 2 and 3 months ahead, each method is given only the months that were known when that forecast would have been made. Its forecast is then compared with what was actually posted. Nothing from the checked month or later leaks into the forecast.

A method that needs more history than was available is skipped for that forecast. A method that could not make any forecast in the window is shown without a rank, with the reason (for example *Needs at least 12 months of history before the first month checked*).

A method checked on fewer than half as many forecasts as the most-checked method is also left unranked, with the count, because an error from one or two forecasts cannot be compared fairly with one from fifteen. Its figures are still shown.

Each method is scored on:

* **Error** (WAPE): the total absolute miss as a share of the total actual figures, in percent. This is the ranking measure, and lower is better. It is used instead of an average percentage error so that a month close to zero does not swamp the result.
* **Error by months ahead**: the same, for 1, 2 and 3 months ahead separately.
* **Average miss** (MAE), in money.
* **Bias**: the average of forecast minus actual. Above zero means the method forecast too high.
* **Within 10%**: the share of forecasts that came within 10% of the actual figure.
* **Checked**: how many forecasts were measured.

Methods are ranked by error, then by average miss. The page shows a sentence about the winner and the runner-up. For example: *Over the last 12 months, straight-line trend forecast revenue best, with an error of 0.0% of the actual figures (next best: last month plus trend, 0.0%).* A chart and a table show the actual figures against the best method and *last month* one month ahead. The page also lists what each method forecasts for the next three months.

When the actual figures in the window are all zero, no percentage can be given; the method with the smallest average miss is named instead.

## Saved runs: measuring forecasts for real

A backtest shows how a method *would have* done. A saved run shows how it *actually* does. **Save this run** (needs `budgets.manage`, with an optional note) keeps:

* the books' last month and the months checked;
* every method's backtest results for every figure;
* every method's forecasts for the next three months.

Runs are numbered FL-0001, FL-0002 and so on. They are **evidence**: a database trigger refuses any update or delete, so a forecast cannot be quietly corrected after the fact.

Once a forecast month is over, the run page shows the actual figure from the books beside each forecast. It also shows each method's error so far. The lab page adds up every saved run into **Saved forecasts, measured**, with the method that has been most accurate so far. Actual figures are read from the books when the page is opened, so later postings and corrections are reflected.

## API

| Route | Permission | |
| --- | --- | --- |
| `GET /v1/orgs/:orgId/forecast-lab?window=6\|12\|18` | `reports.read` | Backtests of every method on every figure, the next three months by every method, saved-run tracking, and the method and figure lists |
| `GET …/forecast-lab/runs` | `reports.read` | Saved runs, newest first, with forecast and measured months |
| `POST …/forecast-lab/runs` `{ window?, note? }` | `budgets.manage` | Save a run. 422 when there are fewer than two months of posted books. Audited as `forecast_lab.run_saved` |
| `GET …/forecast-lab/runs/:id` | `reports.read` | One run with each forecast's actual (null until the month is over) and its tracking |

## Tests

* `packages/accounting-engine/test/forecast-lab.test.ts`: each method's forecast, the accuracy measures, the rolling origin never seeing the checked month, ranking and unranked methods.
* `apps/api/test/forecast-lab.e2e.test.ts`: twelve months of rising sales (the trend methods win with 0.0% error; *last month* misses by 10,000, 20,000 and 30,000 for 1, 2 and 3 months ahead), saving a run, an older run measured against the books, the database refusing changes and deletion, the audit event, an empty organisation, permissions and tenant isolation.
* `apps/web/e2e/forecast-lab-flow.test.mjs`: the lab and a saved run in the browser.

## Limitations

* The methods are simple statistical ones, chosen so their results can be explained and checked by hand. There is no ARIMA, seasonal decomposition or machine-learning model, and no AI is involved.
* One figure at a time: methods are not combined, and the lab does not change which method the cash-flow forecast or budgets use.
* Organisation-wide figures only, not by department or project.
* Saved runs keep the forecasts as made; the actual figures are always read from the current books.
