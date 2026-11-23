# Canadian GST/HST return (TAX-034)

Canadian organisations keeping their books in Canadian dollars get the GST/HST return (regular
method) prepared from the books on the same page and API as the UK, Singapore and Australian
returns, through the jurisdiction layer in `packages/tax-engine/src/vat/jurisdictions.ts`
(TAX-041). The engine is `packages/tax-engine/src/ca/gst-hst.ts`.

## Set-up

- **Business number**: 9 digits passing the Luhn check, then `RT` and the 4-digit program account
  reference (`123456782RT0001`). Spaces and dashes are allowed.
- **Registered from** and **return periods**: monthly, or quarterly on the fiscal quarters. The
  annual reporting period is not offered.
- **Treatments**: taxable (GST/HST), zero-rated, exempt and out of scope. Canada has no reduced
  rate. Rates at 5% (GST) and 13%, 14% and 15% (HST) are suggested as taxable; a taxable rate at
  any other percentage (for example a combined GST and PST rate) is warned about, since PST and QST
  are not on this return.
- **Starter rates**: GST 5%, HST 13% (Ontario), HST 14% (Nova Scotia from 1 April 2025), HST 15%
  (New Brunswick, Newfoundland and Labrador, Prince Edward Island) and 0% zero-rated.

## The lines

| Line | Figure |
| --- | --- |
| 101 | Sales and other revenue: credits less debits on revenue accounts, closing entries left out, GST/HST excluded, to the nearest dollar (zero-rated and exempt supplies included) |
| 103 | GST/HST collected or collectible on taxable sales |
| 104 | Adjustments: 0 (not modelled) |
| 105 | 103 + 104 |
| 106 | Input tax credits on taxable purchases and expense claims, plus ITCs missed on earlier returns |
| 107 | Adjustments: 0 (not modelled) |
| 108 | 106 + 107 |
| 109 | Net tax: 105 − 108, shown as a positive amount with pay or refund |

## Due dates

A monthly or quarterly return and its payment are due one month after the reporting period ends.

## Corrections

The CRA lets input tax credits missed on an earlier return be claimed on a later one, within four
years for most registrants. When the only change to returns already recorded as filed is more
ITCs, it is claimed at line 106 of the next return. GST/HST reported wrongly or ITCs over-claimed
are not carried: the warning says to ask the CRA to adjust the earlier return.

## Not modelled

PST and QST, the place-of-supply rules that pick the province's HST rate, the Quick Method and
other simplified methods, the line 104 and 107 adjustments (bad debts, meals and entertainment,
rebates), instalments and rebates (lines 110 to 115), self-assessment, the annual reporting period
and the shorter two-year ITC limit for large businesses and listed financial institutions.
Nothing is filed with the CRA from Talk2Tax.
