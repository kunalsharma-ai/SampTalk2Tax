# Pro forma invoices

Registry: **AR-008 Pro forma invoices**.

A pro forma invoice tells a customer what they will be billed before the sale: to collect an
advance, or for the customer's own approvals (a purchase order, an import licence, a letter of
credit). It is **not a tax invoice** and **posts nothing**. Once the goods or services are supplied
(or the payment is received), it is turned into an ordinary tax invoice with the same lines.

## Making one

**Sales → Pro forma invoices → New pro forma invoice**, or **Make pro forma invoice…** on a sent or
accepted quotation (the customer, lines, place of supply, reference and terms are filled from it).

The lines and totals are worked out by the same code as an invoice: tax rates, India GST place of
supply and the CGST/SGST or IGST split, on the pro forma's date. It needs a date and a **valid
until** date, and takes the customer's reference, terms and a memo. It is saved as a draft and
numbered **PF-0001**, **PF-0002** and so on.

## Issuing and printing

**Issue** fixes it: from then on its customer, dates, lines and figures cannot change (a database
trigger enforces this). To change an issued one, cancel it and make a new one.

**Print or PDF** prints it with the organisation's invoice template (or the built-in one for the
country), headed **Pro forma invoice**, marked *Not a tax invoice*, with **Valid until** in place of
the due date. A draft prints with a DRAFT stamp and a cancelled one with VOID.

## Advance and tax invoice

* **Record advance…** opens a new receipt for the customer. The receipt stays on the customer's
  account until it is applied to the tax invoice.
* **Make tax invoice…** creates a **draft invoice** dated as you choose (not before the pro forma),
  with the same lines and prices worked out again by the invoice rules on its date, referenced
  `PF-0001` (and the customer's reference). Review and post it like any invoice, then apply the
  advance to it.
* Deleting that draft invoice, or voiding the posted one, frees the pro forma to be invoiced again.
* A pro forma past its valid date can still be invoiced or cancelled.

**Cancel…** (with a reason) closes an issued pro forma that will not be invoiced. A draft can be
deleted.

| Action | Permission |
| --- | --- |
| See and print pro forma invoices | `sales.read` |
| Create, change, issue, invoice, cancel, delete | `sales.manage` |

## API

Under `/v1/orgs/:orgId/sales/pro-formas`:

| Method | Path | |
| --- | --- | --- |
| GET | `/?view=open\|invoiced\|all&contactId=` | pro forma invoices with totals |
| POST | `/` | `{ contactId, quoteId?, issueDate, validUntil, placeOfSupply?, reference?, terms?, memo?, lines: [{ accountId, description?, quantity, unitPrice, taxRateId?, hsnCode? }] }` |
| GET | `/:id` | one, with its lines, quotation and tax invoice |
| GET | `/:id/print?templateId=` | the print source (kind `PRO_FORMA`) and the template |
| PUT | `/:id` | change a draft (same body) |
| DELETE | `/:id` | delete a draft |
| POST | `/:id/issue` | |
| POST | `/:id/invoice` | `{ issueDate, dueDate? }`: the draft tax invoice |
| POST | `/:id/cancel` | `{ reason }` |

Invoice HTML templates get `doc.isProForma` and `doc.dueLabel` for pro formas.

## Not yet

* Pro forma invoices in a foreign currency.
* Emailing the pro forma to the customer from the app.
* Invoicing part of a pro forma (one tax invoice per pro forma for now).
