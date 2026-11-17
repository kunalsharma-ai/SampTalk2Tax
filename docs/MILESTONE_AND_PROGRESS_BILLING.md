# Milestone and progress billing (AR-013, AR-014)

A sales order can be billed one of three ways. The method is chosen on the order's page under
**How this order is billed**, before the first invoice. Once part of the order is billed on an
invoice that is not void, the method is fixed (checked by the API and by a database trigger).

| Method | What each invoice bills |
| --- | --- |
| By delivery (default) | The quantities you choose of each line (CRM slice 2). |
| By milestones (AR-013) | A reached milestone's share of every line. |
| By progress (AR-014) | Every line up to the percent complete, less what earlier claims billed. |

Shares are applied to line quantities, so every invoice keeps the order's prices, tax rates, HSN
codes and India GST place of supply, and is worked out by the same invoice rules. Invoices are made
as drafts, then reviewed and posted like any invoice. Order lines record what each invoice billed in
`sales_order_billings`, as for delivery billing, so the order's "billed" and "still to bill" figures
work the same for all three methods.

## Milestones

* **Plan milestones**: names, shares in percent (at most 2 decimal places, above 0, at most 100 in
  all) and optional due dates. A plan below 100% is allowed; the rest can be added later.
* **Mark reached** when the work is done (who and when are recorded); a milestone can be set back
  to not reached while it is not invoiced.
* **Make invoice…** on a reached milestone. The order is billed up to the shares of all milestones
  invoiced (on invoices that are not void) plus this one: each line's target is
  `quantity × share / 100`, rounded half up to 6 decimal places, less what is billed already. When
  the shares reach 100% the invoice takes exactly the quantities left, so the order is billed in full.
* An invoiced milestone keeps its name and share and cannot be removed or reopened (API check and
  the `t2t_check_sales_order_milestone` trigger). Voiding its invoice frees it to invoice again;
  deleting the draft clears the link.

## Progress claims

* **Claim progress…** with the percent complete (above the highest claim on a live invoice, at most
  100), an invoice date and an optional note. Each line is billed up to that share less what is
  billed; 100% bills the rest.
* Claims are a record and cannot be changed (trigger). A voided invoice's claim is struck through
  and no longer counts; deleting the draft removes the claim.

## Rounding

Each invoice rounds its own lines to the currency's minor unit. Splitting a line priced 3,333.33
three ways can therefore bill 3,000.00 + 2,500.00 + 4,500.00 = 10,000.00 for an order line of
9,999.99: the invoices together can differ from the order total by a paisa per line and invoice.
Quantities always add up exactly.

## API

All under `/v1/orgs/:orgId/sales/orders/:id` (read needs `sales.read`, changes need `sales.manage`):

* `PUT billing-method` `{ method: DELIVERY | MILESTONES | PROGRESS }`
* `PUT milestones` `{ milestones: [{ id?, name, percent, dueDate? }] }` replaces the plan
* `POST milestones/:mid/complete` `{ done }`
* `POST milestones/:mid/invoice` `{ issueDate, dueDate? }` returns `{ documentId, order }`
* `POST progress-claims` `{ percentComplete, issueDate, dueDate?, note? }` returns `{ documentId, order }`
* `POST invoices` (delivery billing) is refused unless the method is `DELIVERY`.

`GET` on the order adds `billingMethod`, `milestones` (share, value, reached, invoice),
`milestonesTotal`, `milestonesInvoiced` and `progress { claimed, claims }`. Every change is in the
audit trail (`sales_order.billing_method_changed`, `.milestones_planned`, `.milestone_completed`,
`.milestone_reopened`, `.billed` with the milestone or percent).

## Estimates (AR-006)

Estimates are the quotations of CRM slice 2 (`QT-0001`, revisions `-R2`), described in
[QUOTES_AND_ORDERS.md](QUOTES_AND_ORDERS.md): drafted, sent, revised, declined, expired and accepted
into sales orders, with pro forma invoices made from them (AR-008).

## Not covered

Retentions (a percent held back from each progress invoice) and certified progress by a third party
are not built. Orders are in the functional currency only, as for delivery billing.

## Tests

* Engine: `packages/accounting-engine/test/project-billing.test.ts`
* API: `apps/api/test/project-billing.e2e.test.ts`
* Browser: `apps/web/e2e/project-billing-flow.test.mjs`
