# Prepaid expenses, deferred revenue and accruals

Milestone 6, slice 2. Three month-end adjustments that keep income and expenses in the month they belong to:

* **Prepaid expenses**: something paid for in advance (insurance, rent, software, an annual maintenance contract). The payment sits in a prepaid account (an asset) and moves to an expense account over the months it covers.
* **Deferred revenue**: money received for something still to be delivered (an annual support contract, advance fees). The receipt sits in a liability account and becomes revenue over the months it covers.
* **Accruals**: an expense incurred or income earned in a month that is not billed yet. It is posted on the last day of the month and reversed automatically on the first day of the next, so the real bill or invoice lands against it.

Everything posts through the normal journal code: periods must be open, entries balance, every posting is in the audit trail, and the database keeps posted history from being changed.

## Schedules

A schedule has a kind (prepaid expense `PP-0001` or deferred revenue `DR-0001`, numbered separately), a name, an optional supplier or customer, an amount, the date it covers from, the number of months (1 to 120) and how it is released:

| Release | How each month's share is worked out |
| --- | --- |
| Evenly by month | The amount divided by the months, rounded, starting in the month of the start date. The last month takes what rounding left, so the total is exact. |
| By days | The amount spread over the days from the start date to the end date (the start date plus the months, less a day). A part month gets its share of days. Each month is the rounded share to date less what was released before, so rounding never adds up. |

For example, ₹36,500 received for 15 April 2026 to 14 April 2027 by days is ₹100 a day: April 2026 releases ₹1,600 (16 days), May ₹3,100, February 2027 ₹2,800 and April 2027 ₹1,400.

Accounts:

| | Balance sheet account | Released to |
| --- | --- | --- |
| Prepaid expense | an asset with subtype Prepaid, Other current asset or Other non-current asset (1400 Prepaid Expenses in the standard chart) | an expense account (not depreciation) |
| Deferred revenue | a liability with subtype Other current liability, Other non-current liability or Accrued liability (2350 Deferred Revenue, added to the standard chart for new organisations) | a revenue account |

When adding a schedule the payment or receipt can be posted at the same time (prepaid: debit the prepaid account, credit the bank or clearing account; deferred revenue: debit the bank, credit the liability). Leave it off when it is already in the books, for example a bill coded to the prepaid account.

A schedule's name and supplier or customer can always change. Its amount, dates, accounts and method are fixed once a release has been posted for it (the API refuses with `SCHEDULE_TERMS_FIXED`, and a database trigger refuses too); reverse the release runs first to change them. When the payment or receipt was posted here, its amount and balance sheet account are fixed from the start.

### Ending a schedule early

A contract cancelled, a policy surrendered, a service delivered early: ending a schedule releases what is left in one entry on the end date, to its own expense or revenue account or to another account (the bank or a receivable for a refund). Releases must be posted through the month before the end (`RELEASES_NOT_POSTED`), and none may be posted for a month after it (`RELEASED_AFTER_END`). An ended schedule is final.

## Monthly releases

Like depreciation, releases are posted for the whole organisation once a month, as one journal on the last day of the month, reference `REL-YYYY-MM`, source `DEFERRAL`. Prepaid lines debit expense and credit the prepaid account; deferred revenue lines debit the liability and credit revenue. Debits and credits are totalled per account, not netted.

* Months are posted in order. A month that was missed (or a schedule added late with an earlier start) is caught up in the next run: each line keeps the month it is for.
* A month can be posted once it has started, not before (`MONTH_NOT_OVER`), and only once (`MONTH_ALREADY_RUN`).
* Only the latest run can be reversed (`NOT_LATEST_RUN`); its journal is reversed on the same date. A run that includes an ended schedule stands (`SCHEDULE_ENDED`).
* A posted month keeps the amount posted. If terms were different when it was posted, the next month catches up the difference and the last month brings the total to the full amount.

The month-end close checklist has a warning, **Prepaid and deferred revenue releases are posted**, that counts the schedules with releases due through the month that are not posted, and links to the Releases page.

## Accruals

An accrual (`AC-0001`) is an expense or income for a month: a description, an optional supplier or customer, the month (this month or earlier), the amount, and two accounts.

| | Income statement account | Balance sheet account | Entry on the last day of the month |
| --- | --- | --- | --- |
| Accrued expense | an expense account | an accrued or other current liability (2200 Accrued Liabilities) | debit expense, credit the liability |
| Accrued income | a revenue account | an other current asset (for example an Accrued Income account) | debit the asset, credit revenue |

Posting it also posts the reversal, dated the first day of the next month (a `REVERSING` entry), so both periods must be open. When the bill or invoice arrives and is posted in the next month, the expense or income nets to the real amount.

An accrual that was wrong can be cancelled with a reason: that posts the opposite of the accrual on its date and the accrual again on its reversal's date, so both months come back to where they were. Cancelling is final and both entries are linked from the accrual.

## API

All under `/v1/orgs/:orgId/deferrals`. Reads need `journals.read`; changes need `deferrals.manage` (owners, admins and accountants).

| Route | What it does |
| --- | --- |
| `GET /` | Every schedule with released and left, and totals still to release |
| `GET /accounts` | Accounts the forms offer, by role |
| `POST /` | Add a schedule; `fundingAccountId` and `fundingDate` post the payment or receipt |
| `GET /:id` | One schedule: terms, the full release schedule, postings and the end |
| `PUT /:id` | Change a schedule (terms only until a release is posted) |
| `POST /:id/end` | End early: `{ date, accountId?, note? }` |
| `GET /releases?month=` | Runs, the next month to post and what posting a month would release |
| `POST /releases/runs` | Post a month: `{ month }` |
| `POST /releases/runs/:runId/reverse` | Reverse the latest run |
| `GET /accruals?month=` | Accruals, newest first, with totals |
| `POST /accruals` | Post an accrual and its reversal |
| `POST /accruals/:id/cancel` | Cancel an accrual: `{ note }` |

Errors follow the usual shape: `DEFERRAL_INVALID` and `ACCRUAL_INVALID` (422, with every problem in `details.errors`), and the 409 conflicts named above.

## Data

| Table | Holds | Kept honest by |
| --- | --- | --- |
| `deferral_schedules` | Kind, number, name, counterparty, balance and income statement accounts, amount, start date, months, EVEN or DAILY, the opening entry, ACTIVE or ENDED with the end date, amount, entry, note and who | numbered per organisation and kind (unique); amounts and end fields consistent (CHECK); never deleted, terms fixed once released, ended is final (trigger); RLS |
| `deferral_runs` / `deferral_lines` | One month's release journal, POSTED or REVERSED; a line per schedule and month | one posted run per month (unique index); a run changes only to record its reversal; lines never change (triggers); RLS |
| `accruals` | Kind, number, description, month, accounts, amount, the entry and its automatic reversal, POSTED or CANCELLED with the two cancelling entries | numbered per organisation; changes only to record a cancellation (trigger); RLS |

All money is `NUMERIC(24,6)` and worked out with decimal arithmetic in `packages/accounting-engine/src/deferrals.ts`.

## Not built yet

Recurring accruals that repeat each month; accruals reversing on a date other than the first of the next month; releasing from a sales invoice or bill line automatically (a document line coded to a prepaid or deferred revenue account does not create a schedule); revenue recognition by performance obligation, milestone or usage (Ind AS 115 / IFRS 15 beyond straight-line over time); foreign-currency schedules; schedules split across departments or projects; reversing a run other than the latest.
