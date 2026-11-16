# Journal templates and recurring journals

Registry: **GL-012 Journal templates**, **GL-007 Recurring journals**.

A **journal template** keeps the lines of a journal that is entered again and again: rent, a
monthly accrual, a management charge, a standing reclassification. A **recurring journal** is a
template with a schedule: it makes the journal by itself every month, quarter, half-year or year.

Every journal a template makes is an ordinary manual journal, made by the same code as one typed
in by hand (`JournalsService.createInTx`). The period must be open to post (and not closed for a
draft), accounts must be postable and active, the receivables and payables control accounts are
refused, foreign-currency lines take the rate recorded for the journal's date, departments and
projects must be active, and debits must equal credits. Nothing about a template bypasses the
ledger's checks or its database triggers.

## Using it

* **Accounting → Journal templates** lists templates (in use, with a schedule, archived, all),
  with the runs due now and any schedule that could not run.
* **New template**: a name, the journal type (standard or adjusting), a memo and reference, and
  the lines. The balance check uses the engine's `checkTemplateLines`, the same rule the server
  applies. A template may have lines in a foreign currency; each currency must balance on its own,
  and is converted at the recorded rate when a journal is made.
* **Save as template** on any journal entered by hand (Journals → open one) copies its lines,
  memo and reference into a new template.
* **Use template** makes one journal dated as you choose: a draft, or posted (needs
  `journals.post`). It is recorded in the template's history as made *by hand*.

### Placeholders

The memo, reference and line descriptions can name the journal's own dates:

| Placeholder | Becomes (journal dated 30 Nov 2026, fiscal year from April) |
|---|---|
| `{date}` | 2026-11-30 |
| `{month}` | November 2026 |
| `{period}` | 2026-11 |
| `{quarter}` | Q3 FY 2026-27 |
| `{fy}` | FY 2026-27 |
| `{year}` | 2026 |

So "Rent for {month}" posts as "Rent for November 2026". A template with no reference gives its
journals the template's own number (JT-0001).

## Schedules

* **Frequency**: monthly, quarterly, half-yearly or yearly from the **first run** date.
* **Run day**: the same day of the month as the first run (the month's last day when a month is
  shorter: 31 Jan, 28 Feb, 31 Mar), or always **the month's last day** (for month-end accruals).
* **Last date** (optional): no run falls after it, and the form says how many runs there are. With
  no last date the schedule runs until it is ended.
* **Each run** either **makes a draft** for someone to check and post, or **posts straight away**.
  Posting needs `journals.post` from whoever sets or resumes the schedule; the runner posts in the
  name of the member who created the template and refuses (with a message on the template) if that
  member can no longer post.
* Scheduled runs are journals of type **Recurring**.

### How runs are made

The **runner** (`RECURRING_JOURNAL_RUNNER_INTERVAL_SECONDS`, default 3600, 0 turns it off; it
appears in System health as "Recurring journals") makes every run whose date has come, for every
active schedule. **Run due now** does the same on request, for one template or all of them.

Runs are numbered from 1. Each run's journal, its history row and the next run number are written
in one transaction, with the template row locked, and `(template, run number)` is unique, so a
run is never made twice, even when the runner and a member press the button at the same moment.
A schedule whose first run is in the past makes the runs already due at the next pass.

If a run cannot be made (a locked or closed period, an inactive account, a missing exchange rate),
**nothing** from that pass is kept, the reason is shown on the template and the list, and the
next pass tries again. Opening the period or fixing the account is enough.

After the run on or before the last date, the schedule **ends** by itself.

### Pause, resume, end

* **Pause**: no runs are made. Archiving a template pauses its schedule.
* **Resume**: either make the runs that fell due while paused (the next pass catches up), or
  **skip** them: runs dated before today are passed over and never made.
* **End**: no more runs. Ending is final for that schedule; saving the template with a later last
  date runs it on from where it stopped.

### What can change

Lines, memo, reference, the last date and draft or post can be changed at any time; they apply to
journals made afterwards. Once a schedule has made a journal, its first run, frequency and run day
stay fixed (the API answers `TEMPLATE_SCHEDULE_RAN`, and a database trigger enforces it), so run
numbers keep meaning the same dates. The run number never goes back.

A template that has made journals is **archived**, not deleted; one that has made none can be
deleted. Deleting a draft journal a run made keeps the run in the history (marked *draft
deleted*), so the run is not made again.

## Data

| Table | Holds |
|---|---|
| `journal_templates` | Number (JT-0001), name, type, memo, reference, status, and the schedule: frequency, start, end, month end, draft or post, schedule status, next run number, last error |
| `journal_template_lines` | Account, debit or credit (one of them, above zero), currency (null: functional), description, department, project |
| `journal_template_runs` | Append-only: run number (null when used by hand), journal date, the journal made, whether it was posted, who made it (null: the runner) |

All three tables have forced row-level security on `org_id` and composite foreign keys to the
organisation's accounts and dimension values. Database checks keep a schedule's fields together,
each line one-sided, the run history append-only (the only change allowed is losing the link to a
deleted draft), and a schedule's shape fixed once it has run.

## API

All under `/v1/orgs/:orgId/journal-templates` (read: `journals.read`; changes: `journals.create`;
posting: also `journals.post`).

| Method | Path | Does |
|---|---|---|
| GET | `/?view=active\|scheduled\|archived\|all` | Templates with totals, schedule, next run and counts |
| POST | `/` | Create (with `schedule` or `null`) |
| POST | `/from-journal/:entryId` | Create from a manual journal |
| GET | `/:id` | Lines, schedule, the next six runs (memos filled), and every journal made |
| PUT | `/:id` | Change lines and schedule |
| DELETE | `/:id` | Delete a template that has made no journals |
| POST | `/:id/use` | `{ date, post }`: make one journal now |
| POST | `/:id/run-due`, `/run-due` | Make the runs due now (one template, or all) |
| POST | `/:id/pause`, `/:id/resume` (`{ skipMissed }`), `/:id/end` | Schedule |
| POST | `/:id/archive`, `/:id/restore` | Archive or restore |

Every change is in the audit trail (`journal_template.*`), and each journal made carries the
template and run number in its audit entry.

## Tests

* `packages/accounting-engine/test/recurring-journals.test.ts`: run dates (anchored and month
  end), due runs, the end date and run counts, placeholders and fiscal years, line checks.
* `apps/api/test/journal-templates.e2e.test.ts`: validation, use by hand with placeholders,
  save from a journal, the runner making each run once, a locked period stopping a run and the
  retry, pause and resume with skipping, fixed schedule shape, database guards, drafts by Run due
  now ending the schedule, archive, permissions and tenant isolation.
* `apps/web/e2e/journal-templates-flow.test.mjs`: the whole flow in the browser.
