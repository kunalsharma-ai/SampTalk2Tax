# German VAT advance return, Umsatzsteuer-Voranmeldung (TAX-031)

EU VAT starts with Germany. German organisations keeping their books in euros get the VAT advance
return (UStVA) prepared from the books on the same page and API as the other VAT and GST returns,
through the jurisdiction layer in `packages/tax-engine/src/vat/jurisdictions.ts` (TAX-041). The
engine is `packages/tax-engine/src/de/ust-voranmeldung.ts`. Other EU member states' returns are
not prepared yet.

## Set-up

- **USt-IdNr.**: DE and 9 digits, the last a check digit (ISO 7064 MOD 11,10).
- **Registered from** and **return periods**: monthly or quarterly (calendar quarters). The
  annual-only case is not offered.
- **Treatments**: standard (19%), reduced (7%), tax-free with input tax deduction (such as
  exports), tax-free without it (such as residential rent) and not taxable.

## Kennzahlen

| Kz | Figure |
| --- | --- |
| 81 | Taxable supplies at 19%: net, whole euros (cents left off), with the tax at 19% of that base |
| 86 | Taxable supplies at 7%: net, whole euros, with the tax at 7% of that base |
| 43 | Other tax-free supplies with input tax deduction, whole euros |
| 48 | Tax-free supplies without input tax deduction, whole euros |
| 66 | Input tax on invoices from other businesses (purchases at 19% or 7%) |
| 83 | Advance payment (or surplus): tax on 81 and 86 less 66 |

The tax on Kz 81 and 86 is worked out from the bases, as the form does. When it differs from the
VAT on the invoices by more than one euro, a warning asks to check the rates. The return also keeps
the total output tax under `output` (not a Kennzahl, not shown), so a filed return shows whether it
was a payment or a surplus.

## Due dates

The return and its payment are due on the 10th day after the period ends. A permanent extension
(Dauerfristverlängerung) moves this a month later and is not modelled.

## Corrections

A change to a period already recorded as submitted (up to four years back) is never carried to a
later return: in Germany an error is corrected by filing a corrected advance return (berichtigte
Voranmeldung) for its own period. The page shows the change on the filed period and a warning on
the next one.

## Not modelled

Intra-EU supplies and acquisitions (Kz 41, 89, 61), the reverse charge (§ 13b), the small-business
rule (§ 19), cash accounting (Ist-Versteuerung), the permanent extension and its special payment,
the annual VAT return, OSS and the recapitulative statement. Nothing is sent through ELSTER.
