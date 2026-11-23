# UK VAT return (TAX-030)

Talk2Tax prepares the nine-box UK VAT return from the books for organisations in the United
Kingdom that keep their books in pounds. It does not submit anything to HMRC: the business enters
the figures in its Making Tax Digital software or HMRC's service and records the submission here.

## Set-up

Tax → VAT return → VAT registration (accounts manage):

- **VAT registration number**: 9 digits (12 with a branch suffix), with or without `GB`, checked
  with HMRC's modulus 97 check digits (the original and the "9755" variant).
- **Registered from**: the effective date on the VAT certificate. No period before it is listed,
  and the first return starts on that date.
- **Return periods**: monthly, or quarterly on one of HMRC's three staggers (periods ending
  March/June/September/December, April/July/October/January or May/August/November/February).
- **Lines with no tax rate**: how they count (outside the scope of VAT by default).
- **VAT treatment of each tax rate**: standard, reduced, zero, exempt or outside the scope of VAT.
  Rates at 20%, 5% and 0% are suggested (0% names containing "exempt" or "outside" are suggested
  accordingly); any other rate must be chosen, and a return that uses it cannot be recorded
  until it is. A rate set against its UK percentage (20% standard, 5% reduced, 0% zero) is
  flagged, never changed.

## What goes in (invoice basis)

| Source | Date | Sign |
| --- | --- | --- |
| Posted invoices, credit notes | issue date | credit notes subtract |
| Posted bills, vendor credits | issue date | vendor credits subtract |
| Approved or reimbursed expense claims | posting (approval) date | |
| A voided document or claim | stays in its own period, and is taken off again in the period of the void date | |

Foreign-currency documents count at their own exchange rate. Boxes (HMRC VAT Notice 700/12):

1. VAT on sales (standard and reduced; exempt and zero add nothing)
2. Northern Ireland EU acquisitions: always 0 (not modelled)
3. Box 1 + box 2
4. VAT on purchases and expense claims
5. The difference between boxes 3 and 4, as a positive figure (pay when 3 > 4, else reclaim)
6. Sales excluding VAT (standard, reduced, zero and exempt), whole pounds, pence left off
7. Purchases excluding VAT, the same way
8. and 9. Northern Ireland EU goods: always 0

Entries outside the scope of VAT are listed by treatment but are on no box.

**Other entries on the VAT accounts** lists posted journal entries in the period on the tax
payable and receivable accounts (and each rate's own accounts) that no document or claim on the
return made: VAT paid to HMRC is expected; a journal moving VAT by hand may mean something is
missing from the return.

## Recording a submission

Accounts manage records the day the return was submitted and HMRC's reference. The boxes, the
period's own figures and the corrections it carried are stored in `vat_returns` and never change
(guards refuse updates and deletes). The page sends box 5 as shown; if the books changed in the
meantime the request is refused (`FIGURES_CHANGED`; the request carries `net`, box 5 as shown) so the person checks again.

## Corrections

When a document is later posted (back-dated) into a submitted period, the period's figures now
differ from those submitted. The next return lists the change (less corrections already made on
later returns, within four years) and adds it to boxes 1 and 4 when the net value is within HMRC's
limit (VAT Notice 700/45): £10,000, or 1% of box 6 up to £50,000. Above the limit the corrections
are left off with a warning to tell HMRC separately (form VAT652). The submitted period itself
shows the change as a warning until it is corrected.

## API

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/orgs/:orgId/tax/vat/settings` | reports.read |
| PUT | `/v1/orgs/:orgId/tax/vat/settings` | accounts.manage |
| GET | `/v1/orgs/:orgId/tax/vat/periods` | reports.read |
| GET | `/v1/orgs/:orgId/tax/vat/return?periodEnd=YYYY-MM-DD` | reports.read |
| GET | `/v1/orgs/:orgId/tax/vat/return/export?periodEnd=` | reports.read (audited) |
| POST | `/v1/orgs/:orgId/tax/vat/returns` | accounts.manage (audited) |

Errors: `NO_VAT_RETURN` (another country), `WRONG_CURRENCY` (books not in pounds), `VAT_NOT_SET_UP`, `INVALID_VRN`, `UNKNOWN_TAX_RATE`, `NOT_A_PERIOD`,
`BEFORE_REGISTRATION`, `RETURN_NOT_READY`, `ALREADY_RECORDED`, `FIGURES_CHANGED`.

## Not covered

Cash accounting, flat rate, annual accounting and margin schemes; the domestic reverse charge and
postponed import VAT; partial exemption; Northern Ireland EU trade (boxes 2, 8, 9); Making Tax
Digital submission (needs HMRC developer credentials and fraud-prevention headers). Not
professional tax advice.

Code: `packages/tax-engine/src/uk/vat-return.ts`, `apps/api/src/vat-return/`,
`apps/web/src/app/orgs/[orgId]/tax/vat-return/page.tsx`.

Singapore's GST F5 uses the same page and API: see `SG_GST_RETURN.md`.
