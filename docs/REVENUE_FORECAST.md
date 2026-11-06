# CRM: revenue forecast

CRM slice 5. *Sales → Revenue forecast* shows revenue before tax still to come, month by month
for 3, 6, 12 or 24 months, from what the organisation already knows. Every figure is worked out
by the server from records you can open (`packages/accounting-engine/src/revenue-forecast.ts`);
nothing is estimated by AI.

## Streams

| Stream | What counts | Which month |
|---|---|---|
| Contracts | Each period of an active contract still to bill, at its net value; auto-renewing contracts run on past their end date; paused ones are left out | The period's invoice date; periods already due but not billed fall in this month |
| Sales orders | What is left to bill on open orders (net, by line: net amount × quantity left ÷ quantity) | This month |
| Pipeline | Open deals: amount × win probability (expected) or the full amount (best case) | The expected close month; an overdue close date falls in this month |
| Other sales | Average monthly revenue of the last three complete months from invoices not made from a contract or an order, credit notes netted | Every month; this month less what such invoices already brought |

**Committed** = contracts + sales orders. **Expected** = committed + weighted pipeline + other
sales. **Best case** = committed + full pipeline + other sales. This month also shows what has been
invoiced so far; the forecast is what is still to come. *What the forecast is made of* lists every
contract period, order and deal behind the figures, linked to the record.

## Saved forecasts and accuracy

*Save this forecast* (needs `sales.manage`) keeps the forecast as it stands that day as RF-0001,
with an optional note. A saved forecast never changes (the database refuses updates and deletes).
As months end, each saved forecast is compared with what was invoiced (income lines of posted
invoices less credit notes, by invoice month). The first month's forecast includes what had
already been invoiced when it was saved, so it compares with the whole month. WAPE is the sum of
|actual − forecast| over the sum of actual, across the months that are over.

## API

| Method | Path | Permission |
|---|---|---|
| GET | `/v1/orgs/:orgId/sales/revenue-forecast?months=12` | reports.read |
| GET | `/v1/orgs/:orgId/sales/revenue-forecast/saved` | reports.read |
| GET | `/v1/orgs/:orgId/sales/revenue-forecast/saved/:id` | reports.read |
| POST | `/v1/orgs/:orgId/sales/revenue-forecast/saved` `{ months, note }` | sales.manage |

Saving is audited (`revenue_forecast.saved`).

## Database

Migration `20261121090000_revenue_forecasts`: `revenue_forecasts` (number, as-of date, horizon,
currency, invoiced so far, committed, expected and best totals, the months and items as JSON, note,
who), with checks on the horizon and totals, a guard trigger that refuses updates and deletes, and
row-level security.

## Tests

`packages/accounting-engine/test/revenue-forecast.test.ts` (4), `apps/api/test/revenue-forecast.e2e.test.ts`
(3: streams by month, saving and accuracy two months on, permissions, tenant isolation, the guard)
and `apps/web/e2e/revenue-forecast-flow.test.mjs`.

## Limits

Sales orders have no delivery dates, so what is left on them is placed in the current month. Deals
are counted once in their close month, not spread as recurring revenue. Quotations without a deal
are not counted. Revenue is recognised at invoice date, not spread over a service period. There is
no AI explanation of the forecast yet. Saved forecasts are made by hand; there is no automatic
monthly snapshot.
