# Country modules

Talk2Tax keeps books in any country and currency, but it only does tax work where a country
module has been built, tested and kept up to date. The master directive forbids claiming
worldwide compliance, so each country says plainly what it supports, what it does not, where its
rules come from and when they were last checked. The modules live in
[`packages/accounting-engine/src/countries.ts`](../packages/accounting-engine/src/countries.ts).

## Levels

| Level | Meaning | Countries |
|---|---|---|
| Full tax module | The country's tax engine is built and tested here | India |
| Starter module | Accounting works, and standard national sales-tax rates can be added as ordinary tax rates. No returns, filings, e-invoicing, payroll or rule checks | United Arab Emirates, United Kingdom, Singapore, Australia, Germany, Canada (federal GST only) |
| Accounting only | Accounting works; the country's sales tax is not modelled | United States, and every country without a module |

Each module lists nine areas (accounting, sales tax rates, returns, tax withheld at source,
e-invoicing, transport documents, payroll, the filing calendar and the invoice layout), each as
Supported, Partly, Starter or Not supported, with a note saying exactly what is covered. Modules
also list their limitations, their sources (the tax authority's own pages) and `reviewedOn`.

## In the app

* **Onboarding.** Choosing a country shows its level and summary before the organisation is
  created, and fills in the usual currency and first month of the financial year.
* **Tax → Country module.** The level, the nine areas, the starter rates with whether each is
  already in your tax rates, what is not covered and the sources.
* **Starter rates.** "Add N starter rates" creates the country's standard rates as ordinary
  (SIMPLE) tax rates: tax on sales posts to 2300 Output Tax Payable and tax on purchases to 1450
  Input Tax Receivable. A rate whose name already exists is left alone, even if its percentage
  differs (the page shows "Yours at 17.5%"). Zero rates post nowhere. If the two accounts are
  missing or inactive, nothing is created and the error says what to do. It needs
  `accounts.manage`, like any tax rate, and is audited (`tax_rate.created` for each rate with
  `source: COUNTRY_MODULE`, and `country_module.starter_rates_added` with the review date).
* **Navigation.** Pages for India-only work (GST returns and settings, e-invoices, e-way bills,
  TDS and TCS, payroll, the compliance calendar) are shown only where the module supports them.
  The API refuses this work for other countries too (`NOT_INDIA`).

Talk2Tax never decides which rate applies to what you sell or buy, and adding a starter rate
does not mean the organisation is registered for that tax.

## API

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /v1/country-modules` | signed in | Every module: code, name, currency, first month, level, sales tax name, summary |
| `GET /v1/country-modules/:code` | signed in | One module in full; a country without one returns the accounting-only module |
| `GET /v1/orgs/:orgId/country-module` | org.read | The organisation's module, each starter rate with `existing` (id, rate, active, `sameRate`), and the tax accounts found |
| `POST /v1/orgs/:orgId/country-module/starter-rates` | accounts.manage | Optional `names` to add some only; returns `created` and `skipped` (with reasons); `409 NO_STARTER_RATES` for full and accounting-only countries, `409 TAX_ACCOUNT_REQUIRED` without the tax accounts. One transaction |

## Tests

* Engine (`test/countries.test.ts`): every module lists each area once, has sources, a review
  date and limitations, and unique starter rates; levels; which pages show where; agreement with
  the invoice layouts; planning starter rates (existing names, case and spaces, unknown choices,
  refusals).
* API (`test/country-modules.e2e.test.ts`): the catalogue, an organisation's module, adding
  starter rates once while keeping the organisation's own rate, permissions, audit, using a
  starter rate on an invoice, and the three refusals.
* Web unit (`test/nav.test.ts`): India-only pages appear only in India; role rules still apply.
* Browser (`e2e/country-modules-flow.test.mjs`): a UK organisation from onboarding to its added
  VAT rates, with no India-only pages and the API refusing payroll.

## Maintenance

Rates and rules change. Each module records `reviewedOn`; when a country's rates change:

1. Check the tax authority's page listed in the module's sources.
2. Change the rate or note in `countries.ts` and set `reviewedOn`. Rates already created in an
   organisation are not changed: a tax rate's percentage is fixed once created, so posted
   documents keep their meaning. Organisations add the new rate and retire the old one.
3. Run the engine tests and update this page.

A module should be re-checked at least every six months and whenever a budget or finance act
changes sales tax. Moving a country from Starter to Full needs its own tax engine, returns,
tests against official examples and a review by a professional in that country.

## Not built

* Returns, filings, reverse charge and schemes for any country other than India.
* State, provincial and local taxes (US sales tax, Canadian HST, PST and QST).
* Payroll outside India, and corporate or income tax anywhere.
* Effective dates on starter rates, and alerts when a module's review is overdue.
* Local statutory financial statements (for example Schedule III in India, FRS 102 in the UK);
  reports follow one standard layout everywhere.
