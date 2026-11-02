# Fixed assets

The fixed asset register lives under **Accounting → Fixed assets**. It holds what the business owns for longer than a year. Each asset records its cost, residual value, accounts, depreciation terms and disposal. Depreciation is posted once a month as a single journal.

## Adding an asset

Each asset records:

* its name, category, serial number and location;
* three accounts: a fixed asset account (`FIXED_ASSET` subtype), an accumulated depreciation account (`ACCUMULATED_DEPRECIATION`) and a depreciation expense account (`DEPRECIATION`);
* when it was acquired and when it was put to use;
* its cost, residual value and depreciation method.

Assets are numbered FA-0001, FA-0002, and so on.

There are three ways an asset can enter the books:

* **Purchase posted from the register.** Choose the account the asset was paid from (bank, cash, a loan or a clearing account). This posts a journal on the acquisition date that debits the asset account and credits that account.
* **Already in the books.** For example, the asset came in through a bill. In that case nothing is posted.
* **Brought in part-depreciated.** For example, the asset is moving over from an earlier system. Give the accumulated depreciation so far and the month it covers. Depreciation here continues from the following month. Such an asset is already in the books, so its purchase cannot be posted again.

Once depreciation has been posted for an asset, its cost, dates, accounts and depreciation terms are fixed. The service enforces this, and so does a database trigger. The name, category, serial number and location can always change. If the purchase was posted from the register, its cost, acquisition date and asset account are fixed from the start.

## Depreciation

These conventions are in `packages/accounting-engine/src/fixed-assets.ts`:

* **Monthly charges.** Depreciation is charged by calendar month. It starts with a full month in the month the asset is put to use and runs through the month it is disposed of, which also counts as a full month.
* **Straight line.** The monthly charge is (cost − residual value) ÷ useful life in months, rounded to the currency. The last month of the life takes whatever is left, so the asset ends exactly at its residual value.
* **Written-down value.** An annual rate applies to the net book value at the start of the fiscal year, or at the first charge if that is later. It is charged in twelve equal monthly parts, and never takes the value below the residual value.
* **Posted months.** A month that has been posted keeps the amount that was posted.

**Depreciation runs** (Accounting → Fixed assets → Depreciation):

* The page proposes the next month and previews each asset's charge. It refuses a month that has not started yet.
* **Post** creates one journal on the last day of the month. It debits depreciation expense and credits accumulated depreciation, totalled by account, with the reference `DEP-YYYY-MM`.
* **Order:** months are posted in order. If a month was skipped, or an asset was added late, the missed months are caught up in the next run. Each caught-up month keeps its own line, but the posting date is the run's month end.
* **Reverse:** only the latest run can be reversed. Its journal is reversed on the same date, so the period must be open. A run that includes an asset since disposed of stands.
* **Concurrency:** one posted run per month, enforced by a unique index. Runs are serialised per organisation with an advisory lock.

The month-end close checklist's "depreciation missing" check now links here.

## Disposal

Enter the date, the proceeds (0 if scrapped), the account that received them, and the income or expense account for the gain or loss. Before disposing:

* depreciation must be posted through the month of disposal (`DEPRECIATION_NOT_POSTED`), so the asset leaves at its right value;
* no depreciation can be posted for a month after the disposal (`DEPRECIATION_AFTER_DISPOSAL`).

The disposal journal is dated on the disposal date:

* debits the proceeds account with the proceeds;
* debits accumulated depreciation with the depreciation to date;
* credits the asset account with the cost;
* takes the difference to the gain or loss account.

A disposed asset cannot be changed.

## API

| Endpoint | Permission | What it does |
|---|---|---|
| `GET /v1/orgs/:orgId/fixed-assets` | journals.read | The register with cost, accumulated depreciation and net book value, plus totals for assets in use |
| `GET …/fixed-assets/accounts` | journals.read | Accounts the forms offer, by role |
| `POST …/fixed-assets`; `PUT …/fixed-assets/:id` | assets.manage | Add or change an asset (`422 ASSET_INVALID`, `409 ASSET_TERMS_FIXED`) |
| `GET …/fixed-assets/:id` | journals.read | One asset: terms, schedule (posted months and the next twelve), postings, disposal |
| `GET …/fixed-assets/depreciation?month=` | journals.read | Runs, the next month, and what a run for a month would post |
| `POST …/fixed-assets/depreciation/runs` `{month}` | assets.manage | Post a month (`409 MONTH_ALREADY_RUN`, `MONTH_NOT_OVER`, `NOTHING_TO_DEPRECIATE`) |
| `POST …/depreciation/runs/:id/reverse` | assets.manage | Reverse the latest run (`409 NOT_LATEST_RUN`, `ASSET_DISPOSED`) |
| `POST …/fixed-assets/:id/dispose` | assets.manage | Dispose of an asset |

`assets.manage` is held by owners, admins and accountants.

## Data

There are three tables, each with row-level security:

* `fixed_assets`: CHECK constraints on amounts, methods, dates and disposal fields, and a guard trigger. Assets are never deleted, their terms are fixed once depreciated, and a disposal is final.
* `depreciation_runs`: one posted run per month. A run is never deleted and changes only to record its reversal.
* `depreciation_lines`: one line per asset and month, never changed. Each line holds its month and amount.

Journals have a new source, `ASSET`. Migration: `20261103030000_fixed_assets`.

## Not built yet

* Asset categories with default terms.
* Revaluation and impairment.
* Partial disposal.
* Transfers between locations.
* Depreciation for the tax books (Income Tax Act block of assets) alongside the company books.
* Units-of-production and other methods.
* Amortisation of intangibles under its own name. Intangibles can still use the register with a fixed asset account.
* Capital work in progress.
* Barcode tagging and photos.

The rates and conventions have not been reviewed against Schedule II of the Companies Act by an accountant.
