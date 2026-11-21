# Scheduled reports (RPT-031, RPT-032)

Reports › Scheduled reports emails a report to members on a weekly or monthly day.

* **Reports**: profit and loss, balance sheet, trial balance, receivables ageing, payables ageing, as PDF, Excel or CSV. The file comes from the same export as the Reports screens, so it shows the same figures for the same dates.
* **Dates**: a run always reports up to the day before it runs. "Last full month" covers the previous calendar month (or its last day, for reports at a date); "This month to the day before" and "Financial year to the day before" are ranges; "As at the day before" is one day.
* **When**: weekly on a weekday, or monthly on day 1 to 28. Runs are checked every `REPORT_SCHEDULE_RUNNER_INTERVAL_SECONDS` (default 900). If the server was down on the day, the run is sent at the next check and the schedule moves to its next date; missed days are not sent one by one.
* **Who gets it**: only members who can read reports. A recipient who leaves, or whose role no longer reads reports, is skipped. The report is produced with the access of the member who set the schedule up; if they can no longer read reports, the run fails until someone edits the schedule.
* **Permissions**: `reports.design` (owners, admins, accountants) set up, change, send and delete schedules; everyone with `reports.read` sees them.
* **Record**: each run is kept with its dates, recipients, file name, SHA-256 of the file and the mail server's answer, and written to the audit trail. Two API processes never send the same run twice: a run is claimed by inserting it first, one per schedule and date.
* **Email**: through the organisation's own mail server (Settings › Integrations) or else the server's `SMTP_URL`. Without either, runs fail with that reason.

`GET/POST /v1/orgs/:orgId/report-schedules`, `GET/PUT/DELETE /v1/orgs/:orgId/report-schedules/:id`, `POST /v1/orgs/:orgId/report-schedules/:id/send`.

Not yet: other reports (general ledger, cash flow statement, management reports), sending to people outside the organisation, a time of day, and more than one report per email.
