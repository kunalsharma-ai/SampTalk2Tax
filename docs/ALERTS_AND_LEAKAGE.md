# Alerts and leakage checks (M4, slice 4)

**Alerts** runs nine checks over the books: cash, overdue customers, compliance due dates, KPI targets, budgets, and money that may be leaking. Each check raises an alert for each thing it finds. The alert holds the figures and records it was raised on, so anyone can check it.

An alert can be in one of four states:

* **open**;
* **acknowledged**, meaning someone is looking at it;
* **dismissed**, with a reason;
* **cleared**, when the checks stop finding it.

Every change is kept in the alert's history and in the audit trail.

* **Rules:** `packages/accounting-engine/src/alerts.ts`. This holds the checks, their settings, the detectors (duplicates, unusual journals, missed billing, budget overruns, overdue customers) and how a run updates the stored alerts. It has no framework or database code.
* **API:** `apps/api/src/alerts`.
* **Web:**
  * **Overview → Alerts**, with a dialog for each alert;
  * **Check settings**;
  * an **Alerts** card on the dashboard.

## The checks

| Check | Area | Finds | Severity | Settings (default) |
|---|---|---|---|---|
| Cash below the minimum balance | Cash | The cash-flow forecast goes below the minimum balance set on the forecast page | Critical if the expected case does, warning if only the low case does | Look ahead (90 days) |
| Overdue customer invoices | Cash | Per customer, the open invoices more than N days past due | Critical if any is more than 90 days overdue, otherwise warning | Days (30), minimum amount (0) |
| Filings and tax payments due | Compliance | Each obligation on the compliance calendar that is overdue, or due within N days and not done | Critical if overdue, warning if due soon | Due within (7 days) |
| KPI target missed | Performance | A KPI that missed its target in the last complete month | Warning | Targets are set on the KPI page |
| Spending over budget | Performance | Expense accounts over the approved budget for the fiscal year to date (complete months only), by at least N% **and** an amount; spending with no budget once it reaches the amount | Warning | 10%, 10,000 |
| Regular customer not billed | Leakage | A customer invoiced in each of the N months before the last complete month, with no invoice in that month | Warning | Months (3) |
| Possible duplicate bill | Leakage | Posted bills from the same vendor for the same total, each within N days of the one before | Warning | Days (7) |
| Possible duplicate payment | Leakage | Posted payments to the same vendor for the same amount, each within N days of the one before | Critical | Days (3) |
| Unusual manual journal | Controls | A manual journal posted in the last 90 days that is N times the median manual journal of the year before and at least an amount, or that was posted more than N days after its date | Info, or warning when both apply | 5×, 100,000, 30 days |

Notes on individual checks:

* **Duplicate bills.** The same vendor invoice number is already refused when a bill is entered. This check catches the same bill entered under a different number.
* **Unusual journals.** Size is only judged once there are at least 5 manual journals in the year before.
* **Missed billing.** Credit notes are subtracted. A month that nets to zero or below counts as not billed.
* **Amounts.** All amounts are in the functional currency and are read from posted records only.

## How alerts are kept in step

1. **When the checks run:**
   * when someone presses **Run checks now** (`alerts.manage`);
   * when anyone opens Alerts (or the dashboard) and the last run is more than **60 minutes** old.

   There is no background schedule.
2. **One alert per finding.** Each alert stays the same record for its whole life, matched by check and finding:
   * one per customer for overdue invoices and missed billing;
   * one per obligation for compliance;
   * one per KPI;
   * one per account and fiscal year for budgets;
   * one per first record of the group for duplicates;
   * one per journal for unusual journals;
   * one in total for cash.
3. **What a run does:**
   * **A new finding** opens an alert.
   * **A finding seen again** refreshes the alert's title, figures and severity.
   * **A cleared alert found again** reopens, and its "back" count goes up.
   * **An open or acknowledged alert no longer found** clears, with the note "No longer found by the checks".
   * **A dismissed alert** stays dismissed, whether it is found again or not.
   * **A check that fails** (for example on bad data) is reported with the run, and its earlier alerts are left as they were.
   * **A check that is turned off** has its open and acknowledged alerts cleared, with the note "The check was turned off".
4. **Concurrent runs.** Runs for one organisation are serialised with a transaction-level advisory lock. An automatic run that finds a newer run already finished writes nothing.

## Acting on an alert

| Action | From | Needs |
|---|---|---|
| Acknowledge (optional note) | Open | `alerts.manage` |
| Dismiss (reason of at least 3 characters) | Open, acknowledged | `alerts.manage` |
| Reopen (optional note) | Dismissed | `alerts.manage` |

A cleared alert cannot be acted on. It comes back by itself if the checks find it again.

Wording follows the directive: an alert says what looks unusual and what to check. It never says that a person did something wrong.

## Permissions

| Action | Permission | Roles |
|---|---|---|
| See alerts, their history and the check settings | `reports.read` | all roles except Employee |
| Run the checks; acknowledge, dismiss or reopen; change settings | `alerts.manage` | Owner, Admin, Accountant |

## Database guards

* **`alert_rule_settings`:**
  * one row per check per organisation;
  * the check must be one of the nine and `params` must be a JSON object (CHECK).
* **`alerts`:**
  * unique on organisation, check and finding;
  * a known check (CHECK);
  * a dismissed alert has a person and a reason, and an acknowledged alert has a person (CHECK);
  * `cleared_at` is set exactly when the status is CLEARED (CHECK);
  * a trigger makes alerts start open, keeps the organisation, check, finding and first-seen time, stops the reopen count from going down, and refuses deletes.
* **`alert_events` and `alert_scans`** are append-only (trigger).
* **Row-level security** applies as on every tenant table.
* **Audit trail:** setting changes, runs started by a person, acknowledgements, dismissals and reopens.

## Not supported yet (do not rely on these)

* **No notifications.** Alerts reach no one by email, SMS, push or chat, and there are no digests. Alerts are seen in the app only.
* **No schedule.** The checks run on request, or when alerts are opened and the last run is over an hour old.
* **No assignment.** Alerts are not assigned to a person, have no due date, and cannot be snoozed.
* **No AI or statistics.** All nine checks are fixed rules with thresholds. There is no machine learning, anomaly scoring or AI explanation.
* **Duplicates.** Only exact amounts from the same contact are matched: no near-amount, cross-vendor or OCR-based matching. Duplicate expense claims are checked separately when a claim is entered.
* **Unusual journals.** Size and posting delay only: no checks on weekend or holiday posting, the user, the accounts, or round amounts.
* **Missed billing.** Missed billing looks only at the last complete month, so an alert clears once a new month starts. It does not use contracts, subscriptions or milestones, which are not modelled yet.
* **Not covered:** vendor bank-detail changes, payroll anomalies and unusual bank activity.

## Tests

* `packages/accounting-engine/test/alerts.test.ts` (11 tests):
  * settings, defaults and refused values;
  * duplicates, including chains and a zero window;
  * unusual journals, by size and by late posting, and with too little history;
  * missed billing across year ends and with credit notes;
  * budget overruns, including unbudgeted spending;
  * overdue customers;
  * how a run opens, refreshes, reopens and clears alerts.
* `apps/api/test/alerts.e2e.test.ts` (9 tests), against real postings:
  * every check finds its case, with its title, amount and evidence;
  * automatic and on-demand runs;
  * acknowledging and dismissing, both kept through later runs;
  * clearing after a payment is voided;
  * reopening;
  * a filing marked done clears its alert;
  * settings that are refused;
  * a tighter threshold finding more;
  * turning a check off and on;
  * database tampering;
  * tenant isolation.
* `apps/web/e2e/alerts-flow.test.mjs` (1 test), in the browser:
  * a run that finds a repeated bill and payment;
  * the evidence and its links;
  * dismissing, including the reason check;
  * acknowledging;
  * clearing after the cause is fixed, with the history;
  * a settings change caught in the page and then saved.

The demo data has one freight bill entered twice and runs the checks once, which finds 13 alerts. The duplicate bill alert is acknowledged. The demo's history was all entered on one day, so its back-dating threshold is set to 365 days. All of it is made up.
