# Expense forecasting (EXP-025)

Expenses → **Expense forecast** (`/expenses/forecast`): what expense claims are likely to cost in the coming months, by expense account.

## Method

`expenseForecast` in `packages/accounting-engine/src/expense-forecast.ts`, from the lines of approved and paid-back claims in the organisation's currency, by the date the money was spent, over the last 12 full months:

- **Recent average**: the average of the last three full months.
- **Seasonal**: with spending in at least 10 of the last 12 months, the recent average is scaled by how the same calendar month last year compared with the year's average, the factor held between 0.5 and 2.
- **Range**: the forecast plus and minus the spread (standard deviation) of the last six months, never below zero.
- **Trend**: the last three months against the three before, as a percentage.
- Accounts with spending in fewer than two of the last six months are listed as **spent on now and then**, not forecast.

Also shown: spending so far this month, approved claims not yet paid back (owed to employees) and submitted claims waiting for approval. Drafts, rejected and void claims do not count. All arithmetic is decimal; no language model is involved.

## API

`GET /v1/orgs/:orgId/expense-forecast?months=1..6` (default 3), permission `expenses.read`.

## Tests

- `packages/accounting-engine/test/expense-forecast.test.ts`
- `apps/api/test/expense-forecast.e2e.test.ts`
- `apps/web/e2e/expense-forecast-flow.test.mjs`

## Not built

Forecasting bills and payroll (see the cash forecast), department budgets (EXP-014) and planned trips or events entered by hand.
