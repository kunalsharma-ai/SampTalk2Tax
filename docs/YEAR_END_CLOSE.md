# Year-end close

Registry: **GL-011 Closing balances**.

At the end of a fiscal year, the revenue and expense accounts are brought to nil. The year's
profit or loss moves to retained earnings in one **closing journal**, dated the last day of the
year. After that the year's profit sits in an equity account, rather than being shown on the
balance sheet as "earnings not yet closed". The next year's revenue and expense accounts then
start from nothing.

## Using it

**Accounting → Year-end close** lists each fiscal year, newest first, with:

* the **profit**: revenue less expenses, with closing entries left out;
* what is **in retained earnings** from the closes in force;
* what is **left to close**: the net balance still in the year's revenue and expense accounts;
* its **status**, which is one of:
  * *Not closed*.
  * *Closed*.
  * *Changed since closing*: something was posted to the year after it was closed.
  * *Nothing to close*.

**Close the year…** is available once the year has ended. Choose the retained earnings account
(the chart's 3200 Retained Earnings is suggested) and check the closing journal shown line by
line. Add a note if you like, then post it. The journal:

* credits each account carrying a debit balance and debits each account carrying a credit
  balance, so every revenue and expense account ends the year at nil;
* credits retained earnings with a profit, or debits it with a loss;
* has the journal type **CLOSING** and the source **YEAR_END**, and is numbered **YE-0001**;
* is dated the year's last day, so the year's last month must be open (not locked or closed).

**Close again…** handles a late adjustment, such as an audit entry posted to the year after it was
closed. The lines are worked out from the balances *including* the closes already made, so only
the difference is posted. If nothing is left, the close is refused with `NOTHING_TO_CLOSE`.

**Reopen…** reverses every close of the year still in force. The reversals are dated the year's
last day and are closing entries too. The profit goes back into the revenue and expense accounts
until the year is closed again. A reason is required.

A closing journal cannot be reversed from the journal page. Reopen the year instead.

## Reports

Closing entries are not part of any period's profit:

* The **income statement**, statutory profit and loss, dashboard, KPIs and management reports,
  budget vs actual, profit by department or project, the virtual CFO, the recovery planner and
  the month-end close checks all leave out journals of type CLOSING. A closed year still reports
  its profit.
* The **balance sheet** and **trial balance** include them. After a close, the balance sheet shows
  the profit in retained earnings, and "earnings not yet closed" covers only years not closed. The
  totals do not change.

This applies to every CLOSING journal, including one entered by hand. Reversing a closing journal
also makes a CLOSING journal, so a reversal never shows up in profit and loss either.

## Rules the server applies

* Closing needs `close.manage` and `journals.post` (owners, admins and accountants). Viewing needs
  `periods.read`.
* A year can be closed only after its last day, in the organisation's own date (`YEAR_NOT_ENDED`).
* Retained earnings must be an active, postable equity account (`RE_ACCOUNT`).
* The close takes a row lock on the year's last period, so two closes of a year cannot run at once.
* The `year_end_closes` table keeps each close as made. The only change allowed is being reversed
  once, and no row can be deleted (database trigger). The type of a posted journal cannot change.

## API

All under `/v1/orgs/:orgId/year-end`:

| Method | Path | |
| --- | --- | --- |
| GET | `/` | fiscal years with their figures and status, every close, the suggested account |
| GET | `/:fiscalYear/preview?retainedEarningsAccountId=` | the closing journal a close would post now |
| POST | `/:fiscalYear/close` | `{ retainedEarningsAccountId, memo? }` |
| POST | `/:fiscalYear/reopen` | `{ reason }` |

## Not yet

* Closing by department or project. The closing lines carry no dimensions; profit by department
  leaves closing entries out, so it is unaffected.
* Locking the year automatically after closing. Lock its months on **Fiscal periods** when the
  books are final.
* Carrying balances into a new organisation's first year. Opening balances are entered as an
  OPENING journal.
