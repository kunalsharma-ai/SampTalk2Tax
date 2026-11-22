# Supplier negotiation (AP-033)

Purchases → Supplier negotiation gives every vendor billed in the last twelve months a negotiation
brief: where the organisation's own books give it leverage, with the saving the books can show.
It is worked out from posted bills, vendor credits and payments only (no outside price data and no
AI model), and nothing on the page changes the books or contacts a vendor.

## Points

| Point | Raised when | Saving shown |
| --- | --- | --- |
| Prices went up | An item bought on two or more bills has a latest unit price 5% or more above its first one in the twelve months | What was paid above the first price |
| Cheaper elsewhere | Another vendor's latest price for the same item is 3% or more below this vendor's latest | The gap times the quantity bought from this vendor |
| You buy a lot | Spend is up 20% or more on the twelve months before, or the vendor takes 25% or more of all purchases | — |
| You pay on time | Three or more bills paid, 90% or more by their due date, and nothing overdue | — (ask for 15 more days or an early-payment discount) |
| Weak scorecard | The vendor's grade on Vendor performance (AP-021) is C or D | — |
| Settle late bills first (caution) | Under 70% of three or more paid bills paid on time, or any bill overdue now | — |

Cautions come first, then the points with the largest savings. The vendor's possible saving adds
up, per item, the larger of its two savings, since they overlap.

## How figures are worked out

- **Items** are matched by HSN/SAC code when a bill line has one, otherwise by its description in
  lower case with punctuation and extra spaces ignored.
- **Unit prices** are in the functional currency, at each bill's own exchange rate. Amounts are
  rounded to the currency's minor unit with banker's rounding.
- **Spend** is posted bills before tax less posted vendor credits; the share is against all vendors'
  spend in the same twelve months.
- **Paid on time** means the bill was fully paid (its last allocation) on or before its due date.
  Overdue means an open bill past its due date today.

## API

- `GET /v1/orgs/:orgId/purchases/negotiation-briefs` — every billed vendor with spend, change,
  share, payment record, grade, points and possible saving, largest saving first.
- `GET /v1/orgs/:orgId/purchases/negotiation-briefs/:contactId` — one vendor's brief with its items
  and every point's reasoning. A vendor with no bills gets an empty brief; another organisation's
  vendor is not found.

Both need `purchases.read`. Engine: `negotiationBrief` in
`packages/accounting-engine/src/supplier-negotiation.ts`.
