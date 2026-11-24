# Cross-border tax reporting (TAX-038)

Tax → Cross-border report (`/orgs/:orgId/tax/cross-border`, `reports.read`).

- Contacts carry an optional ISO 3166-1 alpha-2 `countryCode` (contact form "Country"; migration
  `20270310100000_contact_country`). Documents are reported under their contact's country.
- `GET /v1/orgs/:orgId/tax/cross-border?from&to` (default: the financial year to date): posted invoices, credit notes,
  bills and vendor credits with contacts in another country, by country (net of credit notes, before tax, converted at
  each document's exchange rate), with tax and the reverse charge recorded.
- EU businesses get the recapitulative statement (EC Sales List / Zusammenfassende Meldung): zero-rated supplies to
  customers in other EU states, by customer VAT ID (the contact's Tax ID).
- Checks (packages/tax-engine `cross-border.ts`): tax charged on a sale abroad; a purchase from abroad with nothing
  charged and no reverse charge; an intra-EU zero-rated supply without the customer's VAT ID; a document in another
  currency, or with place of supply 96 in India, whose contact has no country.
- `GET .../tax/cross-border/export`: CSV, recorded as `cross_border_report.exported` in the audit trail.

The checks are general guidance and need an adviser's review; nothing is filed or sent. Outside India documents cannot
be marked reverse charge yet, so imported services show up as checks to account for on the return.
