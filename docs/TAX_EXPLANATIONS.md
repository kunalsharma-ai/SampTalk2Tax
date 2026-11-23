# Source-backed tax explanations (TAX-052)

Every invoice, credit note, bill and vendor credit that carries tax has a card on its page called
**How the tax was worked out**. It gives the total in one line. Choosing **Explain the tax** opens the
explanation. Every point names where it comes from:

- **Books:** a record in Talk2Tax. This can be the document itself, the contact's GSTIN or state, a tax
  rate and its versions, the HSN/SAC on a line, or the PAN.
- **Law:** the provision that sets the rule. Examples are the IGST Act s.10 and s.12 (place of
  supply), s.7 and s.8 (inter-state and intra-state supply), CGST Act s.9(3) and s.49(4) (reverse
  charge), s.16 and s.17(5) (input tax credit), s.34 (credit and debit notes), rule 34 (exchange
  rate), rule 46 (HSN on the invoice), and the Income-tax Act 2025 s.393(1) table entry for TDS.

## What it explains

- The place of supply, and why the supply is intra-state (CGST with SGST or UTGST) or inter-state
  (IGST). Exports are explained as zero-rated.
- Reverse charge, and when a self-invoice is due.
- Input tax credit on bills, with its conditions. Blocked credits cannot be decided from the books,
  so they are left to the user to check.
- Credit notes, vendor credits and debit notes.
- Documents in a foreign currency.
- Each line's tax: the amount at the rate, the CGST and SGST halves, or IGST. Nil-rated, exempt,
  non-GST and simple (non-GST) tax rates are covered too.
- When the tax rate changed before the document date, it says so: the original rate, and the rate in
  force since the version date (TAX-003).
- TDS or TCS: the section, rate and base, why the base can be larger than the document (the yearly
  threshold was crossed), whether a PAN is on file, and when the tax is due to the government.
- **Worth checking:** things the books show that need a person. Examples are a missing HSN code, a
  bill with GST from a supplier who has no GSTIN, reverse charge on a line that is not in the notified
  list, and a line rate that differs from the rate in force on its date.

## How it is built

`packages/tax-engine/src/india/tax-explanations.ts` (`explainDocumentTax`) builds the explanation
from the document as posted and from fixed rules. It computes nothing new: every figure is the one on
the document. No AI model is used, so the explanation cannot invent a rule or a number.

## API

- `GET /v1/orgs/:orgId/sales/documents/:documentId/tax-explanation` needs `sales.read`.
- `GET /v1/orgs/:orgId/purchases/documents/:documentId/tax-explanation` needs `purchases.read`.

Both are read-only. The response holds `summary`, `points[]`, `lines[]`, `checks[]` and `basis`.
Every point and line carries `sources[]`, each with a `kind` of `LAW` or `BOOKS` and a `label`.

## Not built

- Explanations in Hindi.
- Explanations for journals, expense claims and payroll.
- Links to the text of the provisions.
