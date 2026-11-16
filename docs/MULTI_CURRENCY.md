# Multi-currency: exchange rates, foreign-currency documents and revaluation

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

## Invoices, bills and payments in another currency

**Sales → Invoices**, **Purchases → Bills**, credit notes, vendor credits, receipts and payments
all have a **Currency** field. In another currency the form shows the organisation's recorded
rate on or before the date (or asks for one) and the amount in the home currency. A rate typed in
is used instead and kept with the record. The rules are in
[`packages/accounting-engine/src/fx-documents.ts`](../packages/accounting-engine/src/fx-documents.ts).

* **Posting.** Every journal line of the document is in its currency at its rate, so the
  receivable or payable is carried at that rate. If rounding each line leaves the home-currency
  totals a few paise apart, the difference goes to the exchange gain/loss account as
  *Currency rounding*. A posted document's or payment's rate never changes (the database refuses it).
* **Settling.** A receipt or credit settles invoices in the same currency only (refused with
  `CURRENCY_MISMATCH` otherwise, and by the database). When its rate differs from the invoice's,
  the difference is a **realised** exchange gain or loss, posted on the allocation date as a
  journal with source `FX_SETTLEMENT`: the control account is moved from the payment's rate to
  the invoice's rate (in the document's currency, so the foreign balance is untouched) and the
  home-currency difference goes to the `FX_GAIN_LOSS` account. Receiving more rupees than the
  invoice was booked at is a gain; paying a bill at a higher rate is a loss. The allocation keeps
  the amount and its journal; removing the allocation reverses that journal the same day.
* **Receivables and payables.** Open items, the ageing, contact balances, credit limits, approval
  thresholds, the cash-flow forecast, alerts, collections and customer 360 work in the home
  currency at each record's own rate, so the ageing still ties to the control account. The ageing
  also shows each foreign item's amount in its currency. A customer or vendor statement is in one
  currency, chosen on the contact's page.
* **Revaluation** at a period end restates what is still open at the closing rate (as above), so
  open foreign receivables and payables show their unrealised gain or loss too.
* **Limits.** On foreign-currency documents: no TDS/TCS and no reverse charge; GST only at zero
  (zero-rated exports, nil-rated, exempt, non-GST), and GST returns show them in rupees at the
  document's rate; no e-invoice or e-way bill. Refusals: `FX_RATE_MISSING`, `FX_INVALID`,
  `FX_ACCOUNT_MISSING`, `CURRENCY_MISMATCH`.

| Endpoint | New fields |
|---|---|
| `POST/PUT /v1/orgs/:orgId/{sales,purchases}/documents` | `currency`, `exchangeRate` (optional) |
| `POST /v1/orgs/:orgId/{sales,purchases}/payments` | `currency`, `exchangeRate` (optional) |
| Document and payment views | `exchangeRate`, `functionalTotal`/`functionalAmount`, `fxGain` per allocation |
| `GET /v1/orgs/:orgId/contacts/:id/statement` | `currency` (query); `currencies` in the answer |

Tests: engine `test/fx-documents.test.ts` (conversion, rounding line, gains and losses on both
ledgers, open amounts); API `test/fx-documents.e2e.test.ts` (rates taken and entered, refusals,
part payments, a gain and a loss, the ageing tying to the books, removal reversing the
difference, statements per currency, bills with a payment and a vendor credit, immutability);
browser `e2e/fx-documents-flow.test.mjs` (a USD invoice, a receipt at a higher rate with the gain
shown before recording, the ageing and the USD statement).

## Not built

* Quotations, sales orders, contracts and expense claims in a foreign currency; TDS/TCS, reverse
  charge and GST above 0% on foreign-currency documents.
* Rate feeds from a central bank or provider; rates are entered by people.
* Revaluation of open receivables and payables by document, and sensitivity or hedging views.
