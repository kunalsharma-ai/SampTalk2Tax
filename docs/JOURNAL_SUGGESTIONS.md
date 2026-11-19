# Automated journal suggestions (GL-036)

**Accounting → Journal suggestions** lists the journals the books suggest for a month. The
suggestions come from two fixed checks over the posted journals of the month and the three before
it. No AI is involved, and nothing is posted until someone checks it.

## The two checks

* **Missed repeat.** A manual journal with the same accounts on the same sides was posted in each
  of the last three months, but this month has none (posted or draft).
  * The suggestion copies the most recent one: its lines, memo, departments and projects.
  * It is dated on the same day of this month, or the month's last day if that is earlier.
  * Reversals, opening and closing journals do not count.
  * In the current month, it appears once that day has come.
* **Accrual.** An expense account had costs in each of the last three months, but nothing at all
  this month.
  * Only costs from bills, expense claims, bank, payments and manual journals count. Depreciation,
    payroll and other system postings do not.
  * The suggestion debits the expense and credits the first active accrued liabilities account
    with the three months' average, rounded to the currency.
  * It is dated at the month end, as an adjusting journal, with a memo saying to reverse it on the
    first of the next month.
  * Accruals are suggested only once the month has ended.
  * An account already covered by a missed repeat is left out.
  * Without an accrued liabilities account, the page says so instead.

## Acting on a suggestion

* **Save as draft journal** creates the draft through the usual journal checks, with period,
  accounts and dimensions checked. It is audited as `journal.draft_created` and
  `journal_suggestion.accepted`. The draft is then checked and posted like any other journal.
* **Dismiss** needs a reason and is audited as `journal_suggestion.dismissed`.
* Each decision is recorded once per month and suggestion in `journal_suggestion_decisions`. The
  guard refuses any change or delete, and a decided suggestion no longer shows for that month.
* Reading needs `journals.read`. Accepting and dismissing need `journals.create`.

## API

* `GET /v1/orgs/:orgId/journal-suggestions?month=YYYY-MM` returns the open suggestions, with each
  line's account, the amounts of the three earlier months and the journals they were based on. It
  also returns notes, and the month's decisions with their journal or reason.
* `POST /v1/orgs/:orgId/journal-suggestions/accept` takes `{ month, key }` and returns the draft
  journal.
* `POST /v1/orgs/:orgId/journal-suggestions/dismiss` takes `{ month, key, reason }`.

A suggestion that no longer applies, or was already decided, gets 409.

## Tests

* **Engine:** `packages/accounting-engine/test/journal-suggestions.test.ts` (4 tests).
* **API:** `apps/api/test/journal-suggestions.e2e.test.ts` (4 tests).
* **Browser:** `apps/web/e2e/journal-suggestions-flow.test.mjs`.

## Limitations

* Only monthly patterns are detected, over a fixed three-month window. Quarterly or yearly
  journals are not suggested, so use journal templates with a schedule for those.
* Foreign-currency lines are copied in the functional currency.
* An accrual's reversal is not created automatically. Reverse the posted journal on the first of
  the next month.
