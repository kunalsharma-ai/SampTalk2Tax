# Singapore GST F5 return (TAX-036)

Singapore organisations keeping their books in Singapore dollars get the GST F5 prepared from the
books on the same page and API as the UK VAT return (see `UK_VAT_RETURN.md`), through the
jurisdiction layer in `packages/tax-engine/src/vat/jurisdictions.ts` (TAX-041: supported
jurisdictions are added one at a time; India keeps its own GSTR-1 and GSTR-3B).

## Set-up

- **GST registration number**: the UEN (8 or 9 digits and a letter, or the T/S/R/F form) or an
  M-number. Only the format is checked; IRAS does not publish its check-letter rules.
- **Registered from**, **return periods** (monthly, or quarterly ending in the months of the
  financial year), **lines with no tax rate**.
- **Treatments**: standard-rated, zero-rated, exempt and out of scope. Singapore has no reduced
  rate; a rate set as reduced holds the return back. Rates at 9%, 8% (2023) and 7% (before 2023)
  are suggested as standard-rated.

## Boxes

| Box | Figure |
| --- | --- |
| 1 | Standard-rated supplies (net) |
| 2 | Zero-rated supplies |
| 3 | Exempt supplies |
| 4 | 1 + 2 + 3 |
| 5 | Taxable purchases: standard-rated and zero-rated purchases and expense claims, net |
| 6 | Output tax due (plus corrections) |
| 7 | Input tax and refunds claimed (plus corrections) |
| 8 | Net GST: 6 − 7, shown as a positive amount with pay or claim |
| 13 | Revenue for the period: credits less debits on revenue accounts, closing entries left out |

Boxes 9 to 12 and 14 onwards (import schemes, tourist refunds, bad debt relief, pre-registration
claims, reverse charge, overseas vendor rules) stay 0. Blocked input tax (GST Regulations 26 and
27) and partial exemption are not applied: every standard-rated purchase line's GST is claimed.

The return and payment are due one month after the period ends.

## Corrections

A document back-dated into a submitted period is found as a change in output or input tax. When
the net GST of the changes is S$1,500 or less, it is added to boxes 6 and 7 of the next return.
Above that the page says to correct the earlier returns with IRAS (GST F7), and they are left off.
Changes are looked for over five years.

## API

The same endpoints as the UK return under `/v1/orgs/:orgId/tax/vat/...`. The responses carry
`jurisdiction` (country, currency, tax and return names, authority, the net box) and `labels` for
the boxes. Recording a submission takes `net`, the net tax as the person saw it (UK box 5,
Singapore box 8).

Errors as for the UK, with `NO_VAT_RETURN` for other countries and `WRONG_CURRENCY` for books
kept in another currency.

Code: `packages/tax-engine/src/sg/gst-f5.ts`, `packages/tax-engine/src/vat/jurisdictions.ts`,
`apps/api/src/vat-return/`, `apps/web/src/app/orgs/[orgId]/tax/vat-return/page.tsx`. Not
professional tax advice.
