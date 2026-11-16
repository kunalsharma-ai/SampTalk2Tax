# Month-end close with an AI review (M5 slice 5)

The month-end close brings closing a month into one place:

* a checklist worked out from the books;
* tasks for accountants for anything still open;
* an AI review that points out what looks unusual and proposes adjusting entries, each posted only when a person approves it;
* closing, which locks the month and records a certification of the figures;
* reopening, which needs a reason.

**Where:** **Accounting › Month-end close**, one page per month. AI reviews also show up under **Governance › AI activity**.

**Permissions:**

| Who | Can |
|---|---|
| `periods.read` (everyone with read access) | See the list and each month |
| `close.manage` (owners, admins, accountants) | Start a close, make tasks, run the AI review, reject proposed entries |
| `close.manage` and `journals.post` | Post a proposed entry |
| `periods.lock` (owners and admins) | Close and reopen a month |

Accountants prepare the close, and an owner or admin certifies it.

**AI switch:** the review uses the organisation-wide AI switch on the Copilot page. The checklist, tasks, closing and reopening work without AI.

## The checklist

The checklist is worked out again each time the page is opened and again inside the closing transaction (`evaluateClose` in `packages/accounting-engine/src/close.ts`).

**Blocking checks** must pass before the month can close:

| Check | Passes when |
|---|---|
| Draft journals | No draft journals are dated in the month |
| Bank lines | Every bank or cash statement line up to the month end is matched or excluded |
| Trial balance | Posted debits equal credits up to the month end |

**Warnings** can be accepted, but the person closing must write a note of at least 10 characters saying why:

| Check | Warns when |
|---|---|
| Draft documents | Draft invoices, bills or credit notes are dated in the month |
| Bank reconciliation | A bank account with statement lines has no completed reconciliation on or after the month end |
| Approvals | Approval requests are waiting |
| Expense claims | Submitted expense claims are waiting for a decision |
| Payroll | There are employees in the month but no posted pay run for it |
| Depreciation | There are fixed assets at the month end but no depreciation was posted in the month |
| Prepaid and deferred releases | Prepaid expense or deferred revenue releases due through the month are not posted ([`PREPAID_AND_DEFERRED.md`](PREPAID_AND_DEFERRED.md)) |
| Cash | A cash account is below zero at the month end |
| AI items | AI items are waiting: proposed adjusting entries for this close, or bank suggestions |
| Earlier months | Earlier months are still open |

Each open check links to where it is dealt with.

**Create tasks for open checks** makes one task per open check (except AI items), with these properties:

* assigned to the Accountant role;
* due 5 days after the month end;
* linked back to the close.

A check that already has an open task does not get a second one.

## The AI review

1. **Starting.** **Review with AI** needs:
   * a Claude key in Settings → Integrations, or the server's `ANTHROPIC_API_KEY` (`503 AI_NOT_CONFIGURED`);
   * AI turned on for the organisation (`409 AI_OFF`);
   * the close started (`409 CLOSE_NOT_STARTED`);
   * the month not closed (`409 CLOSE_CLOSED`) and the period open (`409 PERIOD_NOT_OPEN`).

   Only one review per close can run at a time (`409 CLOSE_REVIEW_BUSY`). A review cut off by a restart is marked `INTERRUPTED` at the next one. A new review supersedes entries from the last one that nobody decided on. The review runs in the background and the page refreshes when it finishes.
2. **What the model sees** (stored with the review, `closeContextForModel`):
   * the checklist;
   * for every account with activity in the month or the three before: its movement this month, the average of the three months before, and in how many of those it was posted to;
   * balance sheet closing balances;
   * a list of income and expense accounts posted to in each of the three months before but not this month (rent, salaries, subscriptions not yet billed);
   * the next period, and whether it is open;
   * the accounts an entry may use: postable and active, and not a bank, cash or control account.

   The model sees account codes and names, never database ids.
3. **The model's answer.** The model must answer with the `submit_close_review` tool (`tool_choice` forces it). It sends:
   * a short summary;
   * up to 10 findings;
   * up to 8 adjusting entries. Each entry has a description, reason, confidence, whether it reverses next month, and debit and credit lines by account code.
4. **The checks** (`checkAdjustment`):
   * 2 to 10 lines;
   * every account is one it was offered;
   * each line is a debit or a credit of a plain positive amount;
   * debits equal credits;
   * a one-line description;
   * for an accrual, the next period exists and is open.

   An entry that fails a check is kept and shown with the failing checks, but it cannot be posted.

## Posting and rejecting

* **Post** creates a journal dated the last day of the month. It goes through the same posting code as every other journal: period lock, validation, numbering and audit. It has source `CLOSE` and a memo marking it as an AI-proposed month-end adjustment.
* **An accrual** also gets its reversal, posted on the first day of the next period in the same transaction.
* **A posted adjustment is corrected** by reversing it like a manual journal. An accrual already has its reversal, so it cannot be reversed again.
* **Reject** keeps the entry with an optional note and posts nothing.

## Closing and reopening

**Closing** (`POST …/close`, `periods.lock`) works in one transaction:

1. It works the checklist out again. Every blocking check must pass (`409 CLOSE_NOT_READY` otherwise). Open warnings need the note.
2. It refuses while a review is running.
3. Entries nobody decided on are set aside.
4. It locks the period, waiting for any posting in progress.
5. It records a certification with:
   * who closed the month, and when;
   * the checklist as it stood;
   * the note;
   * the month's revenue, expenses and net profit;
   * assets and liabilities at the month end;
   * the trial balance totals;
   * the number of journals posted in the month.

While a close stands, unlocking the period from the Fiscal periods page is refused (`409 PERIOD_CLOSE_CERTIFIED`).

**Reopening** (`POST …/reopen`, `periods.lock`) works like this:

* It needs a reason of at least 10 characters.
* It is refused while a later month is closed (`409 LATER_MONTH_CLOSED`).
* It unlocks the period and records who reopened it and why on the certification. The certification itself stays as it was.
* The month can then be closed again, which records a new certification.

## What the database guarantees

Migration `20261102230000_month_end_close` adds these guarantees:

* **Closes:**
  * one close per period;
  * a close keeps its period and who started it, and is never deleted.
* **Certifications:**
  * never deleted, never changed, except to record one reopening (once) with a reason of at least 10 characters;
  * at most one certification in force per close.
* **Reviews:**
  * one running review per close;
  * a finished review is frozen;
  * a done review has a summary and findings, and a failed one has an error.
* **Adjusting entries:**
  * what the model proposed (lines, reason, confidence and checks) never changes;
  * a posted, rejected or superseded entry is frozen;
  * an entry is posted only with resolved lines and a journal;
  * an entry is never deleted.
* **Row-level security** applies on all four tables.

## Audit trail

The audit trail records:

* `close.started`, `close.tasks_created`;
* `close.review_started`, `close.reviewed`, `close.review_failed`;
* `close.adjustment_posted`, `close.adjustment_rejected`;
* `close.certified`, `close.reopened`;
* `period.locked` and `period.unlocked`, marked as done by the close.

## API

| Route | Permission | |
|---|---|---|
| `GET /v1/orgs/:orgId/close` | periods.read | Months up to the current one, newest first, with close status and who closed them |
| `GET …/close/:periodId` | periods.read | The checklist with links and tasks, readiness, AI status, the latest review, proposed entries, certifications and what the caller can do |
| `POST …/close/:periodId/start` | close.manage | Start the close (idempotent). `409 PERIOD_IN_FUTURE` |
| `POST …/close/:periodId/tasks` | close.manage | Tasks for open checks: `{ created, close }` |
| `POST …/close/:periodId/reviews` | close.manage | Start an AI review (`201`) |
| `POST …/close/adjustments/:id/post` | close.manage + journals.post | `409 NOT_POSTABLE` unless waiting and passed its checks |
| `POST …/close/adjustments/:id/reject` | close.manage | Optional `note`. `409 NOT_REJECTABLE` unless waiting |
| `POST …/close/:periodId/close` | periods.lock | `note` (required with open warnings) |
| `POST …/close/:periodId/reopen` | periods.lock | `reason` (at least 10 characters) |

## Tests

* `packages/accounting-engine/test/close.test.ts` covers:
  * every checklist check and the note rule;
  * entry checks: allowed accounts, debit or credit, amounts, balance, reversal into a locked or missing period;
  * the text the model reads;
  * parsing.
* `apps/api/test/close.e2e.test.ts` (11 tests) uses a scripted model and covers:
  * the checklist from real books, and tasks made once;
  * no key, AI off and permissions;
  * what the model is shown;
  * four proposed entries (two pass, two fail their checks);
  * an accrual posted with its reversal next month, through the journal code;
  * rejection;
  * database guards;
  * closing refused, then closed with a note: the period is locked, unlocking it is refused, and the certification totals are right;
  * reopening;
  * reversing a posted adjustment;
  * a refusal, a rate limit and one review at a time;
  * the AI activity log.
* `apps/web/e2e/close-flow.test.mjs` takes an owner through the whole flow in the browser, through the real SDK against the stand-in.

## Not supported yet

* Not yet run against the live Claude API (there is no `ANTHROPIC_API_KEY`).
* A person starts each close and each review. Nothing starts on its own as a month ends, and there is no reminder schedule.
* Proposed entries cannot be edited before posting: reject one and post a journal by hand.
* Entries are in the functional currency only. There is no tax, no dimensions, and no recurring accrual templates.
* No report pack is generated at close. The certification records the headline figures, and the management report for the month is finalised separately.
* A month can be closed out of order, with a warning. Year-end closing to retained earnings is not part of this.
