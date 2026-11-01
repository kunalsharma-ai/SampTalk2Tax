# Budgets and budget vs actual (M4, slice 1)

A budget holds twelve monthly amounts for each revenue and expense account in a fiscal year. Budget vs actual compares a budget with the posted ledger by month, quarter or year.

* **Rules:** `packages/accounting-engine/src/budgets.ts`: spreading, copying last year, checks and variance. It has no framework or database code, and the web editor uses the same functions.
* **API:** `apps/api/src/budgets`.
* **Web:**
  * **Planning → Budgets**: the versions of each fiscal year.
  * A version page: the monthly grid, approval and history.
  * **Planning → Budget vs actual**.

## How it works

1. **Fiscal years.** The months come from the organisation's fiscal year start (April for India). A year is labelled by the calendar year it ends in, so FY2027 runs from April 2026 to March 2027. The page offers last year, this year and next year.
2. **Versions.** Each year can hold several numbered versions (v1, v2, …). A new version starts in one of three ways:
   * **empty**;
   * **as a copy of another version** (of any year);
   * **from last year's actuals**: each month's posted revenue and expense for each account, changed by a percentage (for example +10% or −2.5%), rounded half-even per month.
3. **Amounts.**
   * Amounts are on each account's normal side: revenue as earned, expenses as spent.
   * Only postable, active revenue and expense accounts can be budgeted.
   * Amounts have at most 2 decimals; blank cells in a row count as zero.
   * **Spread** splits an annual amount over the twelve months to the paisa: each month gets the amount rounded down, and the remaining paise go one each to the earliest months. So ₹100 becomes four months of ₹8.34 and eight of ₹8.33.
   * Saving replaces the accounts that changed; an account can be taken out of the budget.
4. **Approval.**
   * A draft can be renamed, changed, deleted or submitted. A version that another version was copied from is kept.
   * A submitted version is fixed. The submitter (or anyone who manages budgets) can withdraw it to draft.
   * An approver can send it back to draft with a reason, which stays on the page until it is next sent back.
   * An approver who did not submit it can approve it. Approving a version **supersedes** the year's earlier approved version, so there is at most one approved budget per year.
   * Approved and superseded versions never change. To revise one, start a new version from it.
   * Every step is in the audit trail.
5. **Budget vs actual.** For each account, and for total revenue, total expenses and net income, the report shows:
   * the actual: posted journals from the start of the year to the "as of" date (today by default);
   * the budget;
   * the difference, and the percentage of the budget.

   Favourable means revenue above budget or spending at or below it. The page opens on the year's approved version and warns when it shows a draft or a superseded version.
   * **Columns:** months, quarters or the whole year, plus year to date and the full-year budget.
   * **Periods not started** show the budget only.
   * **The period in progress** compares its whole budget with the actuals so far, and is marked "in progress".
   * **Year to date** compares the budget of the months that have started with their actuals.
   * **Accounts with actuals but no budget** appear as **Not budgeted**, so unplanned spending and income are visible.

## Permissions

| Action | Permission | Roles |
|---|---|---|
| See budgets and budget vs actual | `reports.read` | all roles except Employee |
| Create, change, delete drafts; submit, withdraw | `budgets.manage` (new) | Owner, Admin, Accountant |
| Approve, send back | `approvals.decide` | Owner, Admin, Approver |

The person who submitted a version cannot approve it or send it back. The API refuses with `SELF_APPROVAL`, and a CHECK constraint in the database (`approved_by_id <> submitted_by_id`) refuses it as well. An organisation with one member can keep and compare draft budgets, but needs a second member to approve one.

## Database guards

* A version is created as a draft.
* Its status moves only DRAFT → SUBMITTED → APPROVED → SUPERSEDED, or SUBMITTED → DRAFT. A trigger enforces this, and CHECKs keep the submitted, approved and superseded fields consistent with the status.
* A version's year, number and origin never change. Only drafts are renamed or deleted, and an approved version's history is fixed.
* There is at most one APPROVED version per organisation and year (partial unique index).
* Lines change only while their version is a draft. They are only for postable revenue and expense accounts, and the month is 1 to 12 (trigger and CHECK).
* Row-level security applies as on every tenant table.

## Not supported yet (do not rely on these)

* **Budget shapes.** No budgets by department, project, location or other dimension, because Talk2Tax has no dimensions yet. No balance sheet or cash budgets, and no capital expenditure plan.
* **Entry.** Budgets are entered by month only: no entry by quarter, no driver-based lines (headcount × salary, price × volume), no seasonal spread from last year's pattern, and no import or export from a spreadsheet.
* **Approval.** One approval step. No approval chains, comments per line or notifications.
* **Forecasts.** No rolling forecasts and no forecast accuracy; budget versions are not forecasts. For cash, see [`CASH_FLOW_FORECAST.md`](CASH_FLOW_FORECAST.md).
* **Reports.** No drill-down from a variance to the journals behind it, no export, and no budget figures on the dashboard yet.
* **Accounting.** The report reads posted journals as they are. If a year-end closing entry to retained earnings is ever posted inside the year, it will show as revenue and expense movements (there is no year-end close yet).

## Tests

* `packages/accounting-engine/test/budgets.test.ts` (8 tests):
  * even and weighted spreads to the paisa, including negative totals and zero weights;
  * last year with a change, rounded half-even;
  * amount checks;
  * months grouped into quarters and the year;
  * favourable and unfavourable for revenue, expenses and net income;
  * a quarter in progress, year to date, unbudgeted accounts and totals;
  * no actuals before the year starts.
* `apps/api/test/budgets.e2e.test.ts` (11 tests):
  * the years offered;
  * a draft and its amounts, with bad accounts and amounts refused;
  * totals;
  * versions from last year's actuals (+10%), and copies;
  * delete rules;
  * submit, the freeze, send back with a reason, self-approval refused, approval by an approver who did not submit;
  * supersession and its audit trail;
  * variance by month, quarter and year against posted journals, including an unbudgeted account and an "as of" date before the year;
  * database tampering: lines of an approved version, rename, delete, status jumps, self-approval and a second approved version;
  * tenant isolation.
* `apps/web/e2e/budgets-flow.test.mjs` (4 tests), in the browser with two signed-in users:
  * spreading and typed amounts with an inline error;
  * saving;
  * submitting;
  * sent back by the approver, resubmitted and approved;
  * budget vs actual by month, with a "not budgeted" account;
  * a new version from the approved one.

The demo data has an approved FY budget, submitted by the demo owner and approved by a synthetic approver, and a draft revision. All of it is made up.
