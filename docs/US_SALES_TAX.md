# US sales tax (TAX-028)

Tax → US sales tax (`/orgs/:orgId/tax/us-sales-tax`), for organisations in the United States.

- **Customer state**: contacts carry `regionCode` (ISO 3166-2 subdivision, such as `TX`); US organisations see a State
  select on the customer and vendor form. Sales count in the customer's state.
- **State rules** (`packages/tax-engine/src/us/sales-tax.ts`): the 50 states and DC, the five without a statewide sales
  tax, and each state's economic nexus threshold (sales, and a number of sales where the state still counts them, with
  AND for Connecticut and New York). Checked on 2026-11-24; needs review by a US sales tax adviser.
- **Permits** (`us_sales_tax_registrations`, migration `20270311100000_us_sales_tax`): state, permit number, effective
  date, the business's own tax rate charged there, and filing frequency. `PUT/DELETE
  /v1/orgs/:orgId/tax/us-sales-tax/registrations/:state` (accounts.manage).
- **Overview** `GET /v1/orgs/:orgId/tax/us-sales-tax?from&to` (reports.read): economic nexus by state from sales this
  calendar year and last (over the threshold, approaching at 80%, below, registered, no sales tax); sales and tax by state
  for the filing period (this month by default); and sales to check: no tax in a registered state, tax in an unregistered
  state, a rate different from the state's recorded rate, a customer with no state.

Not modelled: local rates and sourcing, use tax, exemption and resale certificates, marketplace facilitator sales, and
filing. No rates are suggested.
