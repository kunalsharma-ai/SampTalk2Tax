# Accounting engine

Package: `packages/accounting-engine` (no framework, no database). Used by the API for every write and read that involves money.

## Money

* `dec("1250.00")` parses a decimal **string**; JS numbers throw. Format: up to 18 integer digits and 10 decimals.
* Arithmetic uses `decimal.js` with 40 significant digits.
* `roundToCurrency` rounds half-even (banker's rounding) to the ISO 4217 minor units (INR/USD 2, JPY 0, KWD/BHD/OMR 3). Unknown currencies are rejected, never guessed.
* Amounts with more decimals than the currency allows are rejected, not rounded.

## Account types

| Type | Normal balance | Statement |
|---|---|---|
| ASSET | Debit | Balance sheet |
| LIABILITY | Credit | Balance sheet |
| EQUITY | Credit | Balance sheet |
| REVENUE | Credit | Income statement |
| EXPENSE | Debit | Income statement |

Each type has an allowed subtype list (e.g. ASSET: CASH, BANK, ACCOUNTS_RECEIVABLE…). Header accounts (`isPostable = false`) group children and cannot take postings. Parents must be the same type and the hierarchy cannot cycle.

## Journal validation (`validateJournal`)

All problems are collected and returned together. An entry is valid only if:

1. It has 2–5,000 lines.
2. Each line has exactly one positive side (debit **or** credit), non-negative, within currency precision.
3. Each account exists in the organisation, is active and postable.
4. Lines in the functional currency have rate 1 (or none). Foreign lines require a positive rate (≤ 10 dp), expressed as functional units per 1 foreign unit.
5. Functional amount per line = round(amount × rate) to functional-currency precision.
6. Total functional debits = total functional credits. Conversion rounding differences are **not** absorbed silently: the error tells the user to add an explicit rounding line (account 7300 in the template).
7. Single-currency entries must also balance in the transaction currency.

## Posting lifecycle

```
          create (post=false)           post (journals.post)
  ──────────▶ DRAFT ─────────────────────────────▶ POSTED ──▶ reverse ──▶ new REVERSING entry (POSTED)
              │ edit / delete                         │
              ▼                                       ▼ immutable forever
```

* Drafts are excluded from every balance and report.
* Posting assigns the next gap-free number `JE-000001…` and re-validates against the current chart.
* Posting is only allowed into an **OPEN** period; drafts may sit in LOCKED periods but cannot be posted until unlocked.
* **Reversal** creates a new entry with debits and credits swapped at the original rates, dated on or after the original, in an open period. An entry can be reversed once; a reversal cannot itself be reversed (post a fresh entry instead).
* Journal types: STANDARD, ADJUSTING, OPENING, CLOSING, RECURRING (set by API), REVERSING (only via reverse).

## Periods

`generateFiscalYear(fy, startMonth)` produces 12 monthly periods; FY is labelled by its end year. Statuses: OPEN → LOCKED ↔ OPEN; CLOSED is terminal (close workflow not built yet).

## Reports

* **Trial balance** (`buildTrialBalance`): per account total debits, credits, net in one column and balance on the normal side; `balanced` flag. Optional `from` for period movement.
* **Income statement** (`buildIncomeStatement`): revenue and expense movement in a date range; net income.
* **Balance sheet** (`buildBalanceSheet`): cumulative balances to a date; current-period earnings not yet closed to retained earnings are shown as `unclosedEarnings` within equity (years closed by the year-end close, `year-end.ts`, carry theirs in retained earnings; profit-and-loss reports leave CLOSING journals out); `balanced` = assets = liabilities + equity.
* **Account ledger** (`buildAccountLedger`): opening balance, entries in date/number order, running balance on the normal side.

All reports use functional-currency amounts of POSTED entries only.

## Tests

* Unit: `packages/accounting-engine/test/*.test.ts` (24 tests), including a seeded random property test of 300 journals asserting the TB and balance sheet always balance.
* Integration: `apps/api/test/ledger.e2e.test.ts` exercises the same rules through the API and the database triggers.

## Not yet built

Recurring templates and schedules, accrual auto-reversal, exchange-rate tables and revaluation, dimension masters, subsidiary ledgers, intercompany and consolidation, cash-basis reporting.
