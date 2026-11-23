# Effective-dated tax rates (TAX-003)

Tax rates are effective-dated and version-controlled. A rate keeps the percentage it was created
with as version 1, in force from the start. Later versions each carry the date they take effect,
the notification or reason, and who recorded them. Open **Settings → Tax rates → History** to see a
rate's versions and schedule a change.

## Which rate applies

- Invoices, bills, credit notes and the other sales and purchase documents use the rate in force on
  their **issue date**, worked out when the document is saved or posted. That covers GST rates too:
  the CGST/SGST/IGST split uses the dated percentage.
- Expense claim lines use the rate in force on **each line's date**.
- The tax rates list shows the rate in force today and the next scheduled change.
- What a posted document or approved claim recorded never changes: the tax is stored on the
  document when it is saved.

The line editors preview tax at today's rate. A document dated on the other side of a scheduled
change is charged at the rate for its date when it is saved.

## Rules

- Versions are added in date order: a new one must take effect after the latest one.
- A version cannot reach back past use. If posted documents or approved claims use the rate on or
  after the new date, the change is refused, so the history always matches what was recorded.
- A version must change the percentage, and stays between 0% and 100%.
- Nil-rated, exempt and non-GST rates stay at 0% and cannot change.
- A scheduled version can be withdrawn, with a reason, until it takes effect. It is kept as
  withdrawn and never deleted. A version already in effect cannot be withdrawn; add a new one.
- Inactive rates must be reactivated before they change.

Versions live in `tax_rate_versions` (append-only; guards refuse rewrites and deletes). Adding a
version writes `tax_rate.version_added`, with the old and new rate and whether it was backdated.
Withdrawing one writes `tax_rate.version_withdrawn`.

## API

- `GET /v1/orgs/:orgId/tax-rates` (accounts.read): `rate` is the rate in force today, plus
  `originalRate` and `nextChange`
- `GET /v1/orgs/:orgId/tax-rates/:id/versions` (accounts.read): the timeline, today's rate, the
  next change and the withdrawn versions
- `POST /v1/orgs/:orgId/tax-rates/:id/versions` `{ rate, effectiveFrom, reason }` (accounts.manage)
- `POST /v1/orgs/:orgId/tax-rates/:id/versions/:versionId/withdraw` `{ reason }` (accounts.manage)

Errors: `VERSION_INVALID` (422, with `details.issues`), `RATE_INACTIVE`, `ALREADY_WITHDRAWN` and
`VERSION_IN_EFFECT` (409).

## Not built

Dated versions for withholding sections beyond their built-in `validFrom`, rate changes published
centrally for every organisation, and previews in the line editors at the document's own date.
