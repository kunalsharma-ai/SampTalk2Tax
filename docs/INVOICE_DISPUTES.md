# Invoice disputes

Registry: **AR-025 Dispute management**.

When a customer queries an invoice (the rate is wrong, part of the goods never arrived, it was
billed twice) the query is recorded as a dispute on that invoice. A dispute says what is disputed,
how much of the invoice it covers, who is working on it and the date to settle it by. Every note
and change is kept in the dispute's history. A dispute moves no money: the credit note or write-off
that settles it does.

## Raising a dispute

Open a posted invoice with something still due and choose **Raise dispute…**.

* **Reason**: price or rate, quantity, quality or damage, not received, billed twice, tax, or other.
* **What the customer disputes**: their query, in their words or yours.
* **Amount in dispute**: up to what is still due on the invoice; empty means all of it.
* **Owner** (a member of the organisation) and **Settle by** (today or later) are optional.

It is numbered **DS-0001**, **DS-0002** and so on. An invoice has at most one open dispute; once it
is resolved, a new query is a new dispute.

## While it is open

* The invoice shows **Disputed: DS-0001** with a link to the dispute.
* The invoice is **left out of payment reminders** drafted by the collections agent, and out of
  workflows on the **An invoice is overdue** trigger (and their test runs).
* It still counts in receivables, the ageing, statements and the daily digest: the money is still
  owed until a credit note or write-off says otherwise.

On the dispute, **Add note** records a call or an email, and **Change…** updates the reason,
description, amount, owner or target date; each change is listed in the history as *from … to …*.

## Resolving

**Resolve…** records how it ended, with a note:

| Outcome | |
| --- | --- |
| Credit note issued | Choose the customer's posted credit note (same currency, dated on or after the invoice). Raise and post it first, then apply it to the invoice as usual. |
| Invoice stands, customer pays | The customer accepted the invoice. |
| Written off | Record the write-off on **Bad debts**; this closes the dispute. |
| Withdrawn by the customer | |

A resolved dispute cannot be changed or reopened (a database trigger enforces this). Its history
cannot be edited.

## Disputes page

**Sales → Disputes** lists disputes (open, resolved or all) with the invoice, customer, reason,
amount, owner, target date and days open, and shows the open count and amount (in the functional
currency), how many are past their target date, the oldest open one, the average days to settle and
how many ended in a credit note.

| Action | Permission |
| --- | --- |
| See disputes | `sales.read` |
| Raise, change, note, resolve | `sales.manage` |

## API

Under `/v1/orgs/:orgId/sales/disputes`:

| Method | Path | |
| --- | --- | --- |
| GET | `/?status=open\|resolved\|all&documentId=&contactId=` | disputes, summary, members |
| POST | `/` | `{ documentId, amount?, reason, description, ownerId?, targetDate? }` |
| GET | `/:id` | one dispute with its history and the credit notes that can settle it |
| PUT | `/:id` | `{ amount?, reason, description, ownerId?, targetDate? }` (open only) |
| POST | `/:id/notes` | `{ body }` |
| POST | `/:id/resolve` | `{ outcome: CREDIT_NOTE\|CUSTOMER_PAYS\|WRITTEN_OFF\|WITHDRAWN, creditNoteId?, note }` |

## Not yet

* Disputes on vendor bills (raised with a vendor).
* A customer raising a dispute from a portal or an e-mailed invoice.
* Holding only the disputed part of an invoice out of reminders (the whole invoice is held).
