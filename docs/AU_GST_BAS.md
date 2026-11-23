# Australian GST on the BAS (TAX-035)

Australian organisations keeping their books in Australian dollars get the GST items of the
business activity statement prepared from the books on the same page and API as the UK VAT return
and the Singapore GST F5 (see `UK_VAT_RETURN.md` and `SG_GST_RETURN.md`), through the jurisdiction
layer in `packages/tax-engine/src/vat/jurisdictions.ts` (TAX-041). The engine is
`packages/tax-engine/src/au/gst-bas.ts`.

## Set-up

- **ABN**: 11 digits, spaces allowed, checked with the ATO's check digits (take 1 from the first
  digit, weight the digits 10, 1, 3, 5, ... 19, and the sum divides by 89).
- **Registered from**: the date the GST registration took effect; no BAS is listed before it.
- **Return periods**: monthly, or quarterly ending September, December, March and June. The UK's
  other quarterly staggers are refused for Australia.
- **Treatments**: taxable (10%), GST-free, input-taxed and out of scope. Australia has no reduced
  rate; a rate set as reduced holds the BAS back. A 10% rate is suggested as taxable, a 0% rate as
  GST-free, input-taxed or out of scope by its name.

## The GST items (Simpler BAS, accruals basis)

| Item | Figure |
| --- | --- |
| G1 | Total sales including GST: taxable sales with their GST, GST-free and input-taxed sales |
| 1A | GST on sales (plus corrections of earlier periods) |
| 1B | GST on purchases: GST on taxable purchases and expense claims (plus corrections) |
| Net | 1A less 1B, shown as a positive amount with pay or refund |

Each item is reported in whole dollars, cents left off. Credit notes and vendor credits are taken
off; a voided document stays in its own period and is taken off again in the period it is voided.
Documents in another currency count at their own exchange rate.

## Due dates

A monthly BAS is due on the 21st of the next month. A quarterly BAS is due on the 28th of the month
after the quarter, except the October to December quarter, due on 28 February. Later dates for
lodging through a registered agent are not modelled.

## Corrections

A business with turnover under A$20 million may correct GST errors of up to A$10,000 net on a later
BAS. Changes to a period already recorded as lodged (up to 18 months back) are found from its
own 1A and 1B figures and carried to the next BAS when within the limit; above it, the warning
says to revise the earlier BAS with the ATO.

## Not modelled

The full GST reporting items (G2 to G20), the cash basis, GST instalments, PAYG withholding and
instalments, fuel tax credits, wine equalisation and luxury car tax, deferred import GST, and the
check that a tax invoice is held before claiming a credit. Nothing is lodged with the ATO from
Talk2Tax: the person enters the figures in ATO Online services and records the lodgment here.
