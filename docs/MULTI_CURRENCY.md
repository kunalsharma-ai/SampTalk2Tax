# Multi-currency: exchange rates and revaluation

Every journal line carries its transaction currency and an exchange rate (functional currency
per one unit), and the books balance in the functional currency. This page adds the rates an
organisation keeps and the period-end revaluation of balances held in other currencies. The
rules are in [`packages/accounting-engine/src/fx.ts`](../packages/accounting-engine/src/fx.ts).

## Exchange rates

**Accounting → Exchange rates.** One rate per currency per day, entered by people with
`accounts.manage`, with an optional source (for example "RBI reference rate"). A rate applies
from its date until the next one. Changing or deleting a rate is audited (`fx.rate_added`,
`fx.rate_changed`, `fx.rate_deleted`). Rates already used in posted journals never change: each
line keeps the rate it was posted with.

A journal line in another currency without a rate takes the latest recorded rate on or before
the entry date. If there is none, the journal is refused and says the rate is needed.

## Revaluation

At a period end, balances kept in another currency are restated at the closing rate:

* Only **monetary** balances: asset and liability accounts except inventory, prepaid expenses,
  fixed assets and accumulated depreciation, which stay at historical rates. Equity, income and
  expenses are never revalued.
* For each account and currency: the foreign balance × the closing rate (rounded half to even
  to the functional currency), compared with what the books carry for those entries. The
  difference moves the account; the total goes to the account with subtype `FX_GAIN_LOSS`
  (7200 Foreign Exchange Gain/Loss in the starter chart) as an unrealised gain or loss.
* The journal (source `FX_REVALUATION`, reference `FXR-0001`…) is posted on the date and
  reversed the next day, so each revaluation starts again from the entries themselves. Both
  dates must be in open periods; a revaluation on the last day of a fiscal year needs the next
  year's periods.
* Closing rates are the recorded rates on or before the date; a different rate can be entered
  for one revaluation and is recorded as entered.
* Revaluations must be dated after the last one. Each is kept as an immutable record (rates,
  balances, carried and revalued amounts, journals); the database refuses changes and deletes.
* It needs `accounts.manage`; the preview needs `reports.read`. Everything is audited
  (`fx.revalued`, and the two journals).

Refusals: `FX_ORDER` (not after the last one), `FX_RATE_MISSING`, `FX_ACCOUNT_MISSING` (no active
FX_GAIN_LOSS account), `FX_NOTHING` (no balances, or already at these rates), `FX_INVALID`.

## API

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /v1/orgs/:orgId/fx/rates?currency=` | reports.read | Recorded rates, newest first |
| `PUT /v1/orgs/:orgId/fx/rates` | accounts.manage | `currency`, `date`, `rate`, `source`; replaces that day's rate |
| `DELETE /v1/orgs/:orgId/fx/rates/:rateId` | accounts.manage | 204 |
| `GET /v1/orgs/:orgId/fx/exposure?asOf=&rate.USD=` | reports.read | Balances by account and currency, rates used, the revaluation it would post, missing rates, balances kept at historical rates, the last revaluation |
| `GET /v1/orgs/:orgId/fx/revaluations` | reports.read | Past revaluations with their journals |
| `POST /v1/orgs/:orgId/fx/revaluations` | accounts.manage | `date`, optional `rates`; posts and reverses; 201 with the record |

## Tests

* Engine (`test/fx.test.ts`): monetary accounts, rate checks, the rate in force, gains and
  losses on assets and liabilities, missing rates, non-monetary balances, rounding in INR and
  JPY books, and a journal that passes the ledger's own validation.
* API (`test/fx-revaluation.e2e.test.ts`): rates (permissions, replacing, checks, audit),
  journals taking recorded rates, the preview at recorded and entered rates, posting and the
  next day's reversal in the trial balance, immutability, and every refusal.
* Browser (`e2e/fx-revaluation-flow.test.mjs`): recording a rate, a USD journal using it, the
  preview at a new rate, posting, and the record.

## Not built

* Invoices, bills, receipts and payments in a foreign currency, and realised gains and losses
  on settling them.
* Rate feeds from a central bank or provider; rates are entered by people.
* Revaluation of open receivables and payables by document, and sensitivity or hedging views.
