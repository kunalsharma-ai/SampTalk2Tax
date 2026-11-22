# Bill exceptions (AP-035)

Purchases → Bill exceptions lists the draft bills that cannot post because they do not match their
purchase order (AP-017), and investigates each difference: its likely cause, what it was compared
with, the next step and the amount at stake. Nothing changes the bill and no AI model is used; the
logic is in `packages/accounting-engine/src/bill-exceptions.ts` and the API is
`GET /v1/orgs/:orgId/purchases/bill-exceptions` (purchases.read).

## Likely causes

| Difference | Likely cause | Next step |
| --- | --- | --- |
| Billed more than received | Goods not received yet, when what is billed can still arrive on the open order | Record the goods received, then post |
| | Billed for more than was delivered, when it cannot (or the order is no longer open) | Ask the vendor to bill only what was supplied |
| Billed more than ordered | May repeat an earlier bill: another bill of the vendor (not void) bills the same quantity at the same price on the same order line, or has the same vendor invoice number | Check for a duplicate and delete it |
| | Billed for more than was ordered | Ask the vendor to bill only what was supplied |
| Price above the order | Vendor's price has gone up: a posted bill of the vendor since the order date charged more than the order price for the same item | Confirm the new price, then accept it |
| | Price differs from the order | Ask the vendor for a corrected invoice |
| Line not on the order | Line not linked: it names an item on the order | Link the line to the order |
| | Extra charge: freight, delivery, shipping, transport, courier, handling, insurance and the like | Confirm the charge, then accept it |
| | Item not on the order | Ask the vendor for a corrected invoice |
| Order closed or cancelled | Nothing more should be billed on it | Check the order before posting |

The vendor's bills of the last year are compared. A bill's next step is the most pressing of its
differences, in the order of the table's next steps: duplicates, then what goes back to the vendor,
then what is fixed on the bill or the order, then what an approver confirms.

## Amount at stake

Each difference has an amount in the bill's currency: the quantity billed beyond what was received
or ordered at the billed price, the price difference times the quantity, or the whole line when it
is not on the order. A bill's amount at stake adds up the largest difference on each line; the
total converts each bill at its exchange rate.

## Settling the differences

Differences are settled as before: correct the bill, record the goods received, or have an
approver (approvals.decide) accept them with a reason. When only a price rise or an extra charge to
confirm is left, the page offers Accept differences with the reason. An accepted bill leaves the
list until it changes.
