# Tax scenario simulations (TAX-049)

Tax → **Tax scenarios** shows what a change to the year's business would do to income tax and GST, against the year's advance tax estimate (Tax → Advance tax: projected income plus adjustments, the regime and the credits).

## A scenario

| Input | Effect |
| --- | --- |
| Change in sales (+/−), with its GST rate | Book profit and taxable income; output GST on the change |
| Change in deductible expenses (+/−), with its GST rate | Book profit and taxable income; input credit on the change |
| Extra depreciation | Lowers profit and taxable income; not cash |
| Expenses not deductible | Added back to taxable income; profit unchanged |
| Tax regime | 22%, 25% or 30% for a company; 30% for a firm or LLP |

Results (tax-engine `simulateTaxScenario`): taxable income; tax, surcharge, marginal relief and cess (`corporateTax`); the change on the estimate; the net payable after credits; the profit after tax and the effective rate; the GST collected, the input credit and the net; and the cash effect (sales less expenses less the change in income tax). Notes warn when the regime changes (the 22% rate cannot be withdrawn; the 25% rate needs turnover of ₹400 crore or less), when expenses are added back, and when there is no taxable income.

**Regimes compared** (`compareRegimes`) gives the tax on the estimate under each regime open to the business, lowest first.

Saved scenarios (`tax_scenarios`, migration `20270217100000`) keep the inputs only and are worked out again against the current estimate on every read. They are never edited; saving and deleting are in the audit trail (`tax_scenario.saved`, `tax_scenario.deleted`). Up to 20 a tax year, names unique within the year.

Not modelled: losses carried forward, minimum alternate tax, exemptions given up under the 22% regime beyond the scenario's own figures, and the timing of instalments. Rates are those of the advance tax module and must be checked against the year's Finance Act. Indian organisations only.

## API

- `GET /v1/orgs/:orgId/tax/scenarios?taxYear=2026-27`: baseline, regimes, GST rates, regime comparison and saved scenarios (reports.read).
- `POST /v1/orgs/:orgId/tax/scenarios/simulate`: works out one scenario without saving (reports.read).
- `POST /v1/orgs/:orgId/tax/scenarios` `{ name, note?, ...scenario }`: saves it (accounts.manage); `NAME_TAKEN` (409).
- `DELETE /v1/orgs/:orgId/tax/scenarios/:id` (accounts.manage).

## Tests

- `packages/tax-engine/test/tax-scenarios.test.ts`
- `apps/api/test/tax-scenarios.e2e.test.ts`
- `apps/web/e2e/tax-scenarios-flow.test.mjs`
