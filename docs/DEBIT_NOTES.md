# Debit notes

Registry: **AR-017 Debit notes**.

A debit note raises the value of an invoice already issued: a price revision, goods short-billed,
or freight added later. Under GST it is the document CGST Act s.34(3) requires when the taxable
value or tax charged on an invoice turns out to be lower than it should be.

## How it works

On a posted invoice, **Raise debit note…** opens a new document for the same customer:

* Enter only the **increase**: the lines, rates and HSN/SAC codes as on any invoice.
* The customer, the currency and (under GST) the place of supply follow the invoice and cannot
  be changed. The debit note cannot be dated before the invoice.
* It can be saved as a draft or posted. Posting numbers it in its own series, **DN-000001**, and
  posts like an invoice: Dr receivables, Cr revenue and output tax.

A debit note is an invoice in every other way. It has a due date, appears in receivables ageing
and on the customer statement, takes receipts and credit notes, and can be written off. Every
report that counts invoices counts it.

The two documents link to each other. The debit note says which invoice it raises, and the
invoice lists its debit notes. The invoices list shows the type **Debit note**.

## Rules

* Only a **posted invoice** can be adjusted, and not a debit note itself. Raise further debit
  notes on the original invoice. (`DEBIT_NOTE_INVALID`)
* The debit note must be to the **same customer**, in the **same currency** and at the **same
  place of supply** as its invoice.
* While a debit note stands (draft or posted), the invoice **cannot be voided**. Void or delete the
  debit note first. (`HAS_DEBIT_NOTES`, also enforced by a database trigger)
* Once posted, the link to the invoice cannot change (database trigger).

## GST

* **GSTR-1** reports debit notes in **table 9B** with credit notes, marked **D** (credit notes are
  **C**), with the invoice they adjust. A small debit note to an unregistered buyer adds to its
  **B2CS** row (table 7), as a credit note is netted there. **Table 13** shows debit notes as their
  own series.
* **GSTR-3B** adds their tax to outward taxable supplies (3.1(a)).
* **E-invoicing** reports them with document type **DBN**.
* The **print** shows the title "Debit note" and "Against invoice INV-… of …" (CGST Rule 53(1A)).
  A template's title is replaced by "Debit note" unless it already says so.

## API

`POST /v1/orgs/:orgId/sales/documents` with `kind: "INVOICE"` and
`debitNoteFor: "<invoice id>"`. The document then has `debitNoteFor`, and the invoice's
`debitNotes` lists it. In lists, `isDebitNote` is true.

## Not yet

* Debit notes received from vendors are entered as bills with the vendor's note number as the
  reference. A separate purchase-side debit note is not modelled.
* Debit notes for invoices without GST work the same way but are only reported in GST returns
  when they carry GST rates.
