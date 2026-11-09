# Vendor performance (AP-021)

A scorecard for every vendor, worked out from what actually happened on their purchase orders,
goods receipts and bills, plus the team's own reviews. Nothing is estimated or generated.

Where: **Purchases → Vendor performance** (every vendor, best first, for a period; by default the
twelve months to today) and the **Vendor performance** card on each vendor's page (the last twelve
months, each order's delivery, and the reviews).

## What is measured

| Part | Weight | From | Score |
| --- | --- | --- | --- |
| On-time delivery | 40 | Issued orders with an expected date placed in the period. An order is delivered on the day its accepted quantity first covers every line (goods receipts that are not cancelled). On time = on or before the expected date. Still short after the date = overdue (late). Closed short = judged on its last delivery. Orders not yet due are left out. | % on time |
| Quality of goods | 30 | Quantity rejected on goods receipts, by value at the order price, against everything received. | 100 − 10 × rejected % (0 at 10% or more) |
| Billing accuracy | 20 | Posted bills in the period linked to an order: the share that matched without an approver accepting differences. | % matched |
| Team reviews | 10 | The average 1 to 5 rating of reviews dated in the period (withdrawn ones left out). | (average − 1) × 25 |

A part with nothing to measure is left out and the others are reweighted; with nothing at all
there is no score. Grade **A** from 90, **B** from 75, **C** from 60, otherwise **D**.

Also shown, not scored: spend (posted bills before tax, in the functional currency), what bills
charged above the order price (bill lines linked to order lines, converted at the bill's rate),
the net price variance, and vendor credits.

## Reviews

Anyone with `purchases.manage` rates a vendor 1 to 5 on Quality, Delivery, Communication, Pricing
or Overall, optionally for one of the vendor's purchase orders. A rating of 1 or 2 needs a note.
Reviews cannot be dated in the future. They are never edited or deleted (a database trigger
refuses it); the author may withdraw their own with a reason, which keeps it on record but leaves
it out of the score. Both are in the audit trail (`vendor_review.created`, `vendor_review.withdrawn`).

## API

* `GET /v1/orgs/:orgId/purchases/vendor-performance?from=&to=` (purchases.read)
* `GET /v1/orgs/:orgId/purchases/vendors/:contactId/performance?from=&to=` (purchases.read)
* `POST /v1/orgs/:orgId/purchases/vendors/:contactId/reviews` `{aspect, rating, note?, orderId?, reviewDate?}` (purchases.manage)
* `POST /v1/orgs/:orgId/purchases/vendors/:contactId/reviews/:reviewId/withdraw` `{reason}` (author only)

## Tests

* Engine: `packages/accounting-engine/test/vendor-performance.test.ts`
* API: `apps/api/test/vendor-performance.e2e.test.ts`
* Browser: `apps/web/e2e/vendor-performance-flow.test.mjs`

Not built: vendor risk monitoring from outside data (AP-024) and supplier tax validation against
the GST portal (AP-019), which need external services.
