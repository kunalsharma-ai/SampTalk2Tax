# Retainers (AR-015)

A retainer is money a customer keeps on account with you at an agreed level, such as a law or
advisory firm's ₹1,00,000 retainer that pays monthly invoices and is topped up when it runs low.

## How it is held

Nothing new is posted. A retainer is a set of ordinary customer receipts that are not yet applied,
linked to it in `retainer_receipts`:

* **Record receipt…** posts a normal receipt (Dr bank, Cr receivables) for the retainer's customer,
  referenced `RT-0001` unless you give a reference, and links it.
* **Add a receipt already recorded…** links a receipt of the same customer that still has an
  unapplied part. A receipt belongs to at most one retainer, for ever.

So until the retainer is used, the customer shows in credit in receivables, ageing and statements,
exactly as for any advance.

**Held** is the unapplied part of the retainer's posted receipts. A void receipt holds nothing, so
voiding one (for example after refunding it) takes it out of the balance.

## Paying invoices

**Pay invoices…** fills the customer's open invoices oldest due first, up to what is held. Change
the amounts to pay other invoices or parts of them. Each part is an ordinary allocation of a retainer
receipt to an invoice, taken from the oldest receipt first (receipts of the same date in the order
they were recorded). Removing such an allocation on the receipt puts the money back in the
retainer. The API also accepts `oldestFirst: true` to pay every open invoice oldest due first.

## Top-ups

A retainer has an agreed amount and a minimum. When what is held falls below the minimum, a top-up
is due: the agreed amount less what is held. The retainers list shows how many are due and the total
to request; the retainer page shows the amount to ask for. Requests are not sent automatically.

| State | When |
| --- | --- |
| Held | Holds at least the minimum |
| Top-up due | Holds something, below the minimum |
| Empty | Holds nothing |
| Closed | Closed with a reason (only when it holds nothing) |

## Rules kept by the database

* Retainers are never deleted; a closed retainer stays closed; a retainer keeps its customer and
  number (`t2t_check_retainer`).
* A retainer receipt must be a posted receipt from the retainer's customer, added while the retainer
  is active, and the link is never changed or removed (`t2t_check_retainer_receipt`).
* Both tables have row-level security.

## API

Under `/v1/orgs/:orgId/sales/retainers` (read needs `sales.read`, changes need `sales.manage`):

* `GET ?view=active|closed|all&contactId=` lists retainers with held, state and top-up due, plus
  totals.
* `POST` `{ contactId, name, amount, minimumBalance, startDate, terms? }`
* `GET :id` adds receipts, the invoices paid from it, the customer's open invoices, and the
  customer's other unapplied receipts.
* `PUT :id` changes the terms while active.
* `POST :id/receipts` `{ date, bankAccountId, amount, reference?, memo? }` or `{ paymentId }`
* `POST :id/drawdown` `{ invoices: [{ documentId, amount }] }` or `{ oldestFirst: true }`
* `POST :id/close` `{ reason }`

Every change is in the audit trail (`retainer.created`, `.updated`, `.receipt_added`,
`.drawn_down`, `.closed`); receipts and allocations keep their own audit events.

## Not covered

* Retainers are held in the functional currency only.
* GST on advances received for services (a receipt voucher with tax) is not worked out. Where it
  applies, raise a tax invoice for the advance instead.
* Top-up requests are not emailed; workflow automations can be used for reminders.

## Tests

* Engine: `packages/accounting-engine/test/retainers.test.ts`
* API: `apps/api/test/retainers.e2e.test.ts`
* Browser: `apps/web/e2e/retainers-flow.test.mjs`
