# Background jobs (PERF-006, PERF-019)

The API runs its background work in each API process. A runner checks for work on a fixed
interval, and the interval is set by an environment variable; `0` turns that runner off. Each
runner reports every pass to the heartbeat service, so **System health** (Platform admin) shows a
runner as failing, or as late once it has missed two passes. The runners pause during maintenance.

When the API runs on several servers, every server runs every runner. Each job therefore has to
act once, however many servers run it at the same moment, and the work of a server that stops
part-way has to be either finished later or left undone, never half done.

| Runner | Interval setting | How it acts once and recovers | Tested with two servers |
| --- | --- | --- | --- |
| Workflow runner | `WORKFLOW_RUNNER_INTERVAL_SECONDS` | Lease per organisation; each event and delivery is claimed; a dead process's lease runs out (QA-016 tests) | Yes |
| Alert checks | `ALERTS_RUNNER_INTERVAL_SECONDS` | Each finding has a fingerprint (its rule and the record it is about), so a repeated pass finds the same alert | No |
| Renewals and reminders | `BILLING_RUNNER_INTERVAL_SECONDS` | The renewal is issued in a transaction that writes the subscription first, so a second server conflicts and then finds it issued. Reminders are sent under a lease per organisation. **Fixed in this change**: before it, two servers could each issue a renewal invoice and email its reminder. | Yes |
| Recurring journals | `RECURRING_JOURNAL_RUNNER_INTERVAL_SECONDS` | Each run is posted in a transaction that moves the schedule's next run number | Yes |
| Recurring bills | `RECURRING_BILL_RUNNER_INTERVAL_SECONDS` | The same, for bills | Yes |
| Contract billing | `CONTRACT_RUNNER_INTERVAL_SECONDS` | Invoices for due periods are made in a transaction that moves the contract's next period | No |
| Scheduled reports | `REPORT_SCHEDULE_RUNNER_INTERVAL_SECONDS` | Each run has a unique key, so a second server's attempt is refused; missed runs are not sent one by one | Yes |
| Month-end close start | `CLOSE_RUNNER_INTERVAL_SECONDS` | Starts the close in a transaction after checking none exists for the period | No |
| CRM webhooks | `CRM_WEBHOOK_RUNNER_INTERVAL_SECONDS` | Lease per webhook; deliveries are retried as the same delivery | No |
| Data retention | `RETENTION_RUNNER_INTERVAL_SECONDS` | Deleting what is past its period again deletes nothing more | No |
| Security monitor | `SECURITY_MONITOR_INTERVAL_SECONDS` | Alerts are unique by rule and key. **Fixed in this change**: a second server opening the same alert at the same moment made its whole pass fail; it now leaves the alert to the first server. | Yes |
| Bill reading | `BILL_READER_RUNNER_INTERVAL_SECONDS` | Each reading is taken with a lease in one conditional write; an expired lease is taken again; three tries, then FAILED (see below) | Yes |

Runners marked No were reviewed for this, but no test has yet run them on two servers.

A server that dies part-way through a transaction leaves nothing behind, and the next pass does
that work again. Work done outside the database is different. If a server dies after sending a
reminder email but before recording it, that reminder may be sent twice; it is never skipped.

## Tests

- `apps/api/test/background-jobs.e2e.test.ts` runs two API processes on one database. Both run
  the same pass at the same moment for recurring journals, recurring bills, subscription renewals
  with their reminders, and security alerts, and each job acts once. The test also checks that
  every runner reports to system health.
- `apps/api/test/workflow-recovery.e2e.test.ts` and `report-schedules.e2e.test.ts` cover workflows
  and scheduled reports in the same way.

## Bill reading (PERF-013)

Reading the text of an uploaded PDF bill is the slow part of the bill reader, so it no longer
happens inside the upload request. The upload checks the file's size and type, scans it, stores
it encrypted as a reading in `QUEUED`, and answers `202` at once. The bill reading worker
(`apps/api/src/bill-reader/bill-reader-runner.service.ts`) is woken by each upload. It also looks
every `BILL_READER_RUNNER_INTERVAL_SECONDS` (default 30; 0 turns it off) for readings left behind
by a server that stopped.

- **Acts once.** A worker takes a reading by moving it from `QUEUED` to `READING` with a
  two-minute lease, in one conditional write. A second server that tries at the same moment
  matches nothing and moves on. Tested with two servers.
- **Recovers.** A reading whose lease has run out is taken again. After three tries it is
  `FAILED`, with a reason. An error during a try puts the reading back in the queue at once.
- **Says why.** A PDF with no text (a scan) ends `FAILED` with the reason the person sees.
  Nothing can be saved or discarded from a reading that is still being read (`NOT_READ_YET`).
- **Audited.** `bill_reading.queued` is recorded at upload. `bill_reading.read` or
  `bill_reading.failed` is recorded before the outcome is shown.

The pages show "Reading…" and refresh by themselves until the reading is done. Pasted text is
still read inside the request, because it is quick. Tests: `apps/api/test/bill-reading-background.e2e.test.ts`
and `apps/web/e2e/bill-reader-flow.test.mjs`.
