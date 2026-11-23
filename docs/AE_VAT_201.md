# UAE VAT return, VAT 201 (TAX-033)

Organisations in the United Arab Emirates keeping their books in dirhams get the VAT 201 prepared
from the books on the same page and API as the other VAT and GST returns, through the
jurisdiction layer in `packages/tax-engine/src/vat/jurisdictions.ts` (TAX-041). The engine is
`packages/tax-engine/src/ae/vat-201.ts`. This is the first of the GCC VAT returns (TAX-033 covers
GCC VAT); Saudi Arabia, Bahrain and Oman are not prepared yet.

## Set-up

- **TRN**: 15 digits beginning 100. Only the format is checked.
- **Emirate**: where the business is established. Every standard-rated supply is reported in that
  emirate's box (1a to 1g), because the emirate of each supply is not recorded on invoices.
  Required: the registration cannot be saved without it.
- **Registered from** and **return periods**: monthly, or the quarterly stagger the FTA assigned.
- **Treatments**: standard-rated (5%), zero-rated, exempt and out of scope. The UAE has no reduced
  rate. A 5% rate is suggested as standard-rated and a 0% rate as zero-rated, exempt or out of
  scope by its name.

## Boxes

| Box | Figure |
| --- | --- |
| 1a to 1g | Standard-rated supplies by emirate, amount and VAT (all in the business's emirate) |
| 4 | Zero-rated supplies |
| 5 | Exempt supplies |
| 8 | Totals: supplies, and VAT on supplies (with corrections) |
| 9 | Standard-rated expenses, amount and recoverable VAT |
| 11 | Totals: expenses, and recoverable VAT (with corrections) |
| 12 | Total value of due tax for the period |
| 13 | Total value of recoverable tax for the period |
| 14 | Payable tax: 12 − 13, shown as a positive amount with pay or repayment |

Boxes 2 (tourist refunds), 3 and 10 (reverse charge) and 6 and 7 (imports) are not prepared. The
boxes are shown in the form's order (`boxOrder`), since object keys that look like numbers sort
first in JavaScript.

## Due dates

A return and its payment are due 28 days after the tax period ends.

## Corrections

An error whose tax difference is AED 10,000 or less may be corrected on the next return. Changes to
periods already recorded as submitted (up to five years back) are found from their own output and
input VAT and carried to boxes 8, 11, 12 and 13 of the next return when within the limit. Above
it, the warning says to submit a voluntary disclosure (Form 211) to the FTA.

## Not modelled

Tourist refunds, the reverse charge, imports, designated zones, the profit margin scheme, partial
exemption, blocked input VAT (such as entertainment and some motor vehicles), the place of supply
of each sale and excise tax. Nothing is submitted to the FTA from Talk2Tax.
