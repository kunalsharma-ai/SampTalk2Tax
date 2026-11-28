# Financial landscape (DASH-023)

Reports → **Financial landscape** draws spending or income by account and month as a 3D landscape. Each account gets one row of towers, each month gets one column, and each tower is as tall as the amount.

## What it shows

- **Show** switches between spending (expense accounts) and income (revenue accounts). **From month** and **To month** choose up to 24 months; the default is the last 12.
- The eight largest accounts over the range get their own row, largest at the front. The rest are joined as one row, "N other accounts".
- Drag the landscape to turn and tilt it. With the keyboard, focus it and use the arrow keys (Shift for bigger steps). **Reset view** and **View from the front** put the camera back.
- **Play months** grows the landscape one month at a time. The **Show months up to** slider picks the last month drawn. Months not reached yet, and months with nothing posted, lie flat and faded.
- The summary gives the total, the tallest tower (account and month) and the busiest month.
- The **Landscape figures** table lists every tower's amount, with month and account totals. Choosing an amount picks out its tower. For a single account it also offers a **Ledger** link to that account's general ledger for the month.

## How the figures are worked out

The figures come from posted journal entries in the functional currency, dated by the entry date. Closing entries are left out, as in the profit and loss. Spending is debits less credits on expense accounts. Income is credits less debits on revenue accounts. `financialLandscape` in `packages/accounting-engine/src/financial-landscape.ts` picks the rows, joins the rest, and works out the month totals, the tallest tower and the busiest month. Amounts are decimals, never floats. The drawing scales heights for display only.

## API

`GET /v1/orgs/:orgId/reports/landscape?from=YYYY-MM&to=YYYY-MM&view=EXPENSES|REVENUE` needs `reports.read`. It defaults to the last 12 months and spending, and allows at most 24 months. It returns `months`, `rows` (label, account ids, one amount per month and a total), `monthTotals`, `total`, `peak` and `busiestMonth`.

Nothing is stored and no AI model is used.

## Evidence

- `packages/accounting-engine/test/financial-landscape.test.ts`: the largest accounts drawn and the rest joined, income and spending signs, the tallest tower and the busiest month, and empty ranges.
- `apps/api/test/financial-landscape.e2e.test.ts`: salaries and rent through the real API and database, drafts left out, income, months checked, reports.read and isolation.
- `apps/web/test/surface-3d.test.ts`: tower geometry and painting order.
- `apps/web/e2e/financial-landscape-flow.test.mjs`: the menu link, the summary and table, turning with the keyboard, the slider, playing and pausing, picking out a tower and opening its ledger, and switching to income.
