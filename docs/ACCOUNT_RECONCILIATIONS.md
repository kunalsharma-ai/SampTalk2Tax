# Account reconciliations (GL-032, GL-023)

Every asset and liability account can be reconciled at a date: its ledger balance is explained by
a list of items, the preparer signs off when nothing is left unexplained, and someone else reviews
it. Bank and cash accounts are still matched line by line in bank reconciliation; this page shows
them too, with a link there, so the whole balance sheet is covered in one list.

## How it works

- **Balances** are read from posted journal entries up to and including the date, in the natural
  sign of the account (debit for assets, credit for liabilities).
- **Items** are either supporting balances (a stock count, a loan statement, a prepaid schedule,
  a statutory payable report) or reconciling items (timing differences, entered with a minus to
  reduce). `packages/accounting-engine/src/account-reconciliation.ts` adds them up; the
  unexplained difference is the ledger balance less the items.
- **Control accounts** (GL-023): the receivable and payable control accounts are compared with the
  open items in their subsidiary ledgers at the date (the ageing). The list shows any difference,
  and the reconciliation offers the ledger's open items as a supporting balance.
- **Sign-off**: `Sign off as preparer` needs a nil difference against the ledger balance at that
  moment. `Mark reviewed` needs a different person, and refuses if the ledger moved since the
  preparer signed off. A reviewed reconciliation cannot be edited; it is reopened with a reason.
- **Changed since sign-off**: the ledger balance is kept as it was when signed off. If a later
  posting changes it, the account shows as changed until it is reopened and signed off again.

## Storage and rules

MongoDB collection `account_reconciliations`, one per organisation, account and date. Guards in
`apps/api/src/db/collections/account-reconciliations.ts` keep the account and date fixed, make
the history only grow, refuse sign-off with a difference, refuse review by the preparer, refuse
edits to a reviewed reconciliation, and refuse deletes. Every save, sign-off, review and reopening
is written to the audit trail (`account_reconciliation.*`).

## API

All under `/v1/orgs/:orgId/account-reconciliations`. Reading needs `reports.read`; working on
them needs `close.manage`.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `?asOf=YYYY-MM-DD` | Every balance sheet account with its balance, subsidiary ledger and status |
| GET | `/:accountId?asOf=` | One account: balance, items, suggestions, sign-offs and history |
| PUT | `/:accountId` | Save the items and notes as a draft |
| POST | `/:accountId/prepare` | Preparer signs off (nil difference only) |
| POST | `/:accountId/review` | Someone else reviews it |
| POST | `/:accountId/reopen` | Back to draft, with a reason |

## Not built

- Attaching evidence files to a reconciliation (files attach to journals and documents today).
- Recurring reconciliation schedules or thresholds that skip small accounts.
- Automatic tasks in the month-end close for accounts not yet reviewed.

## Tests

- `packages/accounting-engine/test/account-reconciliation.test.ts`
- `apps/api/test/account-reconciliations.e2e.test.ts`
- `apps/web/e2e/account-reconciliations-flow.test.mjs`
