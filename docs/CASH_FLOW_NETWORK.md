# Cash-flow network (DASH-024)

Reports → **Cash-flow network** shows where cash came from and where it went, for each cash and bank account. It draws an animated network you can play month by month.

## What it shows

- **Left:** groups that paid money in. These are customers and income, owners, lenders, assets sold, tax refunds and other.
- **Middle:** each cash and bank account. The six busiest get their own node, and the rest are joined as "N other cash accounts".
- **Right:** groups that money was paid out to. These are vendors and spending, payroll, tax, lenders and interest, assets bought and other.
- Money moved only between your own cash accounts arcs between them in the middle column. It counts as neither money in nor money out of the business.
- A line's width is its share of the largest flow in the period. Its dashes move the way the money went. They stand still, and widths change without animating, when the device asks for reduced motion.
- **Play months** steps through the months chosen (up to 24) one at a time. The slider and the **Cash by month** table choose a single month, and **All months** adds them up.
- Choosing an account or group (click, or Enter on the keyboard) picks out its flows. The **Cash flows** table then lists only those flows.

## How the flows are worked out

The figures are read from posted journal entries that move a cash or bank account (subtype `CASH` or `BANK`). They use functional-currency amounts and are dated by the entry date. `cashFlowNetwork` in `packages/accounting-engine/src/cash-flow-network.ts` does the work. For each entry:

1. The net movement of each cash account is its debits less its credits.
2. Money moved between two cash accounts is a transfer, up to the part the rest of the entry does not explain.
3. Cash in is split over the accounts the entry credits, in proportion to their amounts. Cash out is split over the accounts it debits. Amounts are rounded to the currency's minor unit, and any rounding difference stays on the largest part, so each account's flows add up exactly to its movement.
4. The other accounts are grouped:
   - receivables and revenue → customers and income;
   - payables, expenses, inventory and prepaid → vendors and spending;
   - payroll liability, payroll expense and employee reimbursements → payroll;
   - tax payable, receivable and expense → tax;
   - long-term debt, credit cards and interest → lenders;
   - equity → owners;
   - fixed assets → assets;
   - anything else → other.

Example: a receipt of 1,180 less a 10 bank fee puts 1,170 into the bank from customers. The fee never touched cash, so it is not a flow.

The statutory view (operating, investing and financing activities) is the cash flow statement, which is a separate report.

## API

`GET /v1/orgs/:orgId/reports/cash-flow-network?from=YYYY-MM&to=YYYY-MM` needs `reports.read`. It defaults to the last 12 months and allows at most 24. It returns:

- `nodes`, with each node's money in and out over the range;
- `months`, with each month's flows, money in, money out and net change;
- `total`, for all the months together;
- `entries`, the number of posted entries that moved cash.

Nothing is stored and no AI model is used.

## Evidence

- `packages/accounting-engine/test/cash-flow-network.test.ts`: grouping, proportional splits to the cent, transfers (including one that pays a fee), the busiest cash accounts drawn and the rest joined, and empty months.
- `apps/api/test/cash-flow-network.e2e.test.ts`: receipts, bill payments, capital and a petty-cash transfer through the real API and database. It also covers drafts left out, months checked, reports.read and isolation.
- `apps/web/e2e/cash-flow-network-flow.test.mjs`: the menu link, the flows table, picking out customers with the keyboard, playing and pausing, choosing a month, an empty month and All months.
