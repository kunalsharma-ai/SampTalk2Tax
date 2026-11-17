# Supplier tax checks (AP-019)

Every active vendor's GSTIN and PAN checked against each other, against the other vendors and
against the GST on their posted bills of the last twelve months, together with what the GST portal
showed when someone in the team looked the GSTIN up. Problems found here put input tax credit or
TDS at risk.

Where: **Purchases → Supplier tax checks** (every active vendor, worst first, filtered to those
with anything to look at, those with a serious problem, or all) and the **Tax checks** card on
each vendor's page.

## What is checked

| Check | Severity | Raised when |
| --- | --- | --- |
| GSTIN not valid | High | The GSTIN fails its format or check character. |
| PAN does not match | High | The PAN inside the GSTIN differs from the vendor's PAN. |
| PAN not valid | High | The PAN fails its format. |
| GST without a GSTIN | High | Posted bills charge GST but the vendor has no GSTIN. |
| Wrong tax head | High | A bill has IGST where CGST and SGST apply, or the other way round, for the supplier's state and the place of supply. |
| Registration not live | High | The latest portal check of the current GSTIN shows it is not active; bills with GST dated from the cancellation or suspension date are listed. |
| Composition supplier charged GST | High | The latest check shows a composition taxpayer and their bills charge GST. |
| State does not match | Medium | The GSTIN's state code differs from the vendor's state. |
| TDS without a PAN | Medium | The vendor has a TDS section but no PAN, so section 206AA's higher rate applies. |
| Same GSTIN on another vendor | Medium | Another active vendor carries the same GSTIN. |
| Bill saved without the GSTIN | Medium | Bills were saved before the vendor's GSTIN was added. |
| Same PAN on another vendor | Low | Another vendor has the same PAN (right for branches in other states). |
| Bill under an older GSTIN | Low | Bills carry a GSTIN other than the vendor's current one. |
| Not checked on the portal | Low | Nobody has recorded a check of the current GSTIN. |
| Check is old | Low | The latest check is more than 180 days old. |
| Legal name differs | Low | The portal's legal name does not resemble the vendor's name. |

The rules live in `packages/tax-engine/src/india/supplier-checks.ts` and are unit tested. Each
issue that is about bills links to them.

## Recording a GST portal check

The **GST portal search** link opens the portal's Search Taxpayer page. Someone with
`purchases.manage` then records what it showed: the status (active, suspended,
cancelled or not found), the taxpayer type, the legal name, the check date (not in the future),
the cancellation or suspension date where there is one, and a note. A check belongs to the GSTIN
it was made for: if the vendor's GSTIN changes, the old checks stay listed as "earlier GSTIN" and
no longer count.

Checks are kept as recorded: a database trigger refuses any update or delete, and each check is
written to the audit trail (`supplier_tax.gstin_checked`). A later check replaces the earlier one
as the vendor's verification.

## Not built yet

There is no automatic lookup through a GST Suvidha Provider (GSP) or the portal's API; that needs
a GSP account and keys, to be added under Settings → Integrations when available. Until then the
check is done by a person and recorded here, never filled in by the app.

## API

- `GET /v1/orgs/:orgId/purchases/supplier-tax` (purchases.read): the report.
- `GET /v1/orgs/:orgId/purchases/supplier-tax/:contactId` (purchases.read): one vendor, with its checks.
- `POST /v1/orgs/:orgId/purchases/supplier-tax/:contactId/checks` (purchases.manage): record a check.
