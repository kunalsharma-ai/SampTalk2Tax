# CRM: quotations and sales orders

CRM slice 2. A customer is offered a **quotation**; when they accept it becomes a **sales order**;
the order is **billed** into ordinary invoices, all at once or as the work is delivered. Every step
uses the same customers, accounts, tax rates and GST rules as invoices, so the figures quoted are
the figures invoiced.

Screens: *Sales → Quotations* and *Sales → Sales orders*, and *Quotations and orders* on each deal's
page (with a *New quotation* button that fills in the customer and the deal).

## Quotations

Numbered `QT-0001` per organisation; a revision of it is `QT-0001-R2`, `QT-0001-R3`.
Each has a customer, an optional deal, a date, a valid-until date, an optional customer reference,
terms, a memo and lines (income account, description, quantity, unit price, tax rate, HSN/SAC).
Lines are worked out by the invoice rules on the server (`DocumentsService.computeSales`): tax per
line, rounded to the currency, and from the GST registration date the CGST/SGST or IGST split by
place of supply, with GST rates and HSN/SAC checks. The form shows the same totals as you type.

| State | What can happen |
|---|---|
| Draft | Edit, delete, *Mark sent* (refused if valid-until is already past) |
| Sent | *Accepted* (makes a sales order), *Declined* (with a reason), *Revise* |
| Expired (sent, past valid-until) | *Declined*, *Revise*; it can no longer be accepted |
| Declined | *Revise* |
| Accepted | Nothing; it links to its order |
| Superseded | Nothing; a later revision was sent |

* **Revise** makes a new draft with the same lines, dated today with the same validity length.
  The earlier version stays as it is until the revision is **sent**; then it becomes *Superseded*
  (a quotation the customer already accepted is never superseded). Only the latest version can be
  answered.
* A sent quotation never changes: a database trigger refuses any change to its figures, dates or
  lines, accepted and superseded quotations are frozen entirely, and only drafts can be deleted.
* The list shows what is awaiting an answer, what was accepted, and the **acceptance rate**
  (accepted out of those answered, accepted or declined).

## Sales orders

Numbered `SO-0001`. An order comes from an accepted quotation (same lines and prices, with the
customer's PO number given when accepting) or is entered directly. Its customer, number, lines and
prices never change (trigger). Linking a quotation or an order to an open deal marks the deal
**won**, with a stage-change entry on the deal's timeline and in the audit trail.

**Billing.** *Bill this order* makes a **draft invoice** at the order's prices and tax, with the
reference `SO-0001 / <customer PO>`. All that is left is offered; lower a quantity to bill part of
a line now and the rest later. The draft is checked and posted like any other invoice (approvals,
credit limit, e-invoicing all apply at posting).

* Billed quantities count while the invoice is a draft or posted. Voiding the invoice, or deleting
  the draft, frees them to bill again.
* Billing more than is left is refused, under a row lock, so two people billing at once cannot
  over-bill.
* The order shows *Not billed*, *Partly billed* or *Billed*, what is still to bill (with tax), and
  each invoice with the line quantities it billed.
* An order can be **cancelled** with a reason only while nothing is billed; it stays on record.

## Permissions

Reading needs `sales.read`; making, sending, answering, billing and cancelling need `sales.manage`
(owners, admins, accountants).

## API

Under `/v1/orgs/:orgId/sales`:

| Method | Path | |
|---|---|---|
| GET, POST | `quotes` | list (`status`, `contactId`, `dealId`), create a draft |
| GET, PUT, DELETE | `quotes/:id` | read, change a draft, delete a draft |
| POST | `quotes/:id/send`, `/accept`, `/decline`, `/revise` | |
| GET, POST | `orders` | list (`view` open/billed/cancelled/all, `contactId`, `dealId`), create directly |
| GET | `orders/:id` | with lines (billed, left) and invoices |
| POST | `orders/:id/invoices` | bill into a draft invoice: `{ issueDate, dueDate?, lines?: [{ orderLineId, quantity }] }` |
| POST | `orders/:id/cancel` | `{ reason }` |

## Not built yet

* No printed or PDF quotation, and no e-mailing it to the customer from the app; *Mark sent*
  records that it was sent.
* Quotations and orders are in the functional currency only.
* An order's lines cannot be amended; cancel it (if nothing is billed) and enter another.
* If a draft invoice made from an order is edited to change quantities, the order still counts the
  quantity it was billed with.
