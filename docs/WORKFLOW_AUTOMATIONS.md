# Workflow automations and tasks (M5, slices 1 and 2)

**Automations** let owners and admins say: *when* something happens in the books, a schedule comes round, or an invoice or bill reaches a date, *only if* some conditions hold, *do* these things. A workflow can:

* **give someone a task**, linked to the record it is about;
* **send an email** to everyone with a role, one member, or the customer or vendor the record is about;
* **send a webhook**, a signed HTTP POST, to another system such as a CRM, a chat tool or an internal service.

**Tasks** are a shared to-do list. People give tasks to each other, and automations give tasks too. Each member sees the tasks given to them or to their role.

| Part | Where |
|---|---|
| Rules: triggers, facts, conditions, validation, templates, retry schedule | `packages/accounting-engine/src/workflows.ts` |
| Runner, schedules, webhook and email delivery | `apps/api/src/workflows/workflow-runner.service.ts`, `workflow-facts.ts`, `webhook.ts`, `email.ts` |
| Workflows: building, versions, testing, run log, retry | `apps/api/src/workflows/workflows.service.ts`, `workflows.controller.ts` |
| Tasks | `apps/api/src/tasks` |
| Web | **Governance → Automations** (`apps/web/src/app/orgs/[orgId]/automations`) and **Overview → My tasks** (`…/tasks`) |
| Database | Migrations `20261102120000_workflow_automations`, `20261102150000_workflow_schedules_email` |
| Tests | `packages/accounting-engine/test/workflows.test.ts`, `apps/api/test/workflows.e2e.test.ts`, `apps/api/test/workflow-schedules.e2e.test.ts`, `apps/api/test/webhook.test.ts`, `apps/web/e2e/automations-flow.test.mjs`, `apps/web/e2e/automations-schedule-email.test.mjs` |
| Local SMTP server for tests | `test-support/smtp-stand-in.mjs` |

## Triggers and their facts

Each trigger offers **facts**: the values that conditions test and that task titles can use as `{{placeholders}}`. Facts are read from the record as it is when the runner handles the event. Money is a decimal string in the organisation's currency, such as `150000.00`.

| Trigger | Starts on | Facts |
|---|---|---|
| An invoice is posted | `document.posted` for an invoice | number, contactName (customer), total, issueDate, dueDate, reference |
| A bill is posted | `document.posted` for a bill | number, contactName (vendor), total, issueDate (bill date), dueDate, reference (vendor invoice number) |
| An invoice or bill is voided | `document.voided` (all four kinds) | kind, number, contactName, total, reason |
| A customer payment is received | `payment.recorded`, receipts | number, contactName, amount, date, reference |
| A vendor is paid | `payment.recorded`, payments | number, contactName, amount, date, reference |
| A manual journal is posted | `journal.posted`, `journal.created_and_posted` for MANUAL journals only | number, date, total (debits), memo, postedBy |
| An expense claim is submitted | `expense_claim.submitted` | number, claimant, total, title |
| An alert opens | `alert.opened`: a new alert, or one that cleared and came back | severity, check, title, amount (at stake) |

Credit notes and vendor credits being posted, and journals made by other modules (invoices, payments, payroll and so on), start nothing.

The invoice, bill, receipt and payment triggers also offer **contactEmail**, the email address saved on the customer or vendor.

### Schedule triggers

| Trigger | Settings | Acts | Facts |
|---|---|---|---|
| On a schedule | Every day, every week on a weekday, or every month on day 1–28; at a time, India time | Once each time the schedule comes round | date, weekday, overdueReceivables, overduePayables, receivablesOutstanding, payablesOutstanding (as of that date; open amounts on posted invoices and bills, overdue meaning due before the date) |
| An invoice is overdue | 1–365 days after the due date | Once per invoice, on the day it is that many days overdue and still has something to pay | number, contactName, contactEmail, total, balance (still to pay), issueDate, dueDate, reference |
| A bill is due soon | 0–90 days before the due date | Once per bill, on the day it is that many days from due and still has something to pay | number, contactName, contactEmail, total, balance, issueDate, dueDate, reference |

* **No backlog.** A schedule trigger acts only on times and dates from when the workflow was last turned on (`activated_at`). Turning on "3 days overdue" does not email every invoice that was already 3 or more days overdue; it emails each invoice that reaches 3 days from then on. An invoice posted late, whose day already passed while the workflow was on, is picked up on the next pass.
* **Once per occurrence.** Each run of a schedule trigger has an occurrence key, `at:<time>` for a schedule and `doc:<document id>:<days>` for a date trigger, and a unique index allows one live run per workflow and key. Turning a workflow off and on again never repeats a reminder for the same document and days. Changing the number of days makes a different key, so the same invoice can be reminded again at the new number of days.
* **Paid in full means no run.** The open amount is the total less allocations of receipts, payments and credits, as of that India date. Voided documents are left out.
* If the API was down when a schedule came round, the next pass acts on the latest time it came round (once), not on every time missed.
* Times are India time (UTC+05:30, no daylight saving). The workflow page shows when a schedule comes round next.

## Conditions

All conditions must hold. With no conditions, the workflow acts every time.

| Fact type | Tests |
|---|---|
| Money | is more than, is at least, is less than, is at most, is. Compared as decimals, never as floating-point numbers |
| Text | is, is not, contains, does not contain, is empty, is not empty. Case and surrounding spaces are ignored |
| Choice (kind, severity) | is one of, is not one of |
| Date | is before, is after, is |

## Actions

A workflow has one to five actions, carried out in order.

* **Create a task.**
  * Title and details with `{{fact}}` placeholders. A missing value shows as "—".
  * The task is for **everyone with a role** (Owners, Admins, Accountants, Approvers, Viewers) or for **one member**.
  * Optionally **due** 0–365 days after the event, in India time.
  * The task is created in the same transaction as the run.
  * If the member has left the organisation, that action fails with a reason. The rest of the run still happens.
* **Send a webhook** to an address. The webhook is queued and sent straight after (see below).
* **Send an email** (see below) to everyone with a role, one member, or the customer or vendor (on triggers that have one). Subject and message use `{{fact}}` placeholders. The email is queued and sent straight after the run commits.

A definition is checked when it is saved, and every problem is listed:

* unknown facts or placeholders;
* the wrong test for a fact;
* an amount or date that is not valid;
* a member who cannot take tasks, or an email to someone who is not a member;
* a webhook address that is not public https;
* schedule settings that are missing or out of range, and settings given to a trigger that takes none (dropped; the database refuses them too);
* an email with no subject or message, a subject on more than one line, or an email to "the customer or vendor" on a trigger without one.

## How the runner works

1. **Events come from the audit trail.** The audit trail is written in the same transaction as the change it records, so it works as a transactional outbox: an event is seen exactly when its change is committed, and never for a change that was rolled back.
2. **One cursor per organisation.** Each organisation has a cursor (`workflow_cursors`) with the last audit event looked at.
   * Every `WORKFLOW_RUNNER_INTERVAL_SECONDS` (default 10), the runner locks each organisation's cursor with `FOR UPDATE SKIP LOCKED`, so two API processes never handle the same events.
   * It reads up to 200 newer events, starts runs, and moves the cursor forward, all in one transaction.
   * Audit ids are committed in order within an organisation, because appends hold a per-organisation lock until commit. So the cursor can never pass an event that is still to commit.
3. **Schedules.** In the same pass, for each organisation with a schedule workflow on, the runner takes a per-organisation advisory lock (`pg_try_advisory_xact_lock`), works out the latest time each schedule came round and the invoices or bills that reach their date, skips occurrences that already have a run, and starts the rest, in one transaction.
4. **A run per workflow and event.**
   * A workflow acts only on events **after it was turned on**. Turning a workflow on records the newest event id while holding the organisation's audit lock. Turning it on never replays history.
   * Every event a workflow listens to gets a **run**, including runs whose conditions did not hold (recorded as *Conditions not met*, with each condition's actual value).
   * A unique index allows one live run per workflow and event.
5. **Webhooks and emails are sent after the transaction.**
   * Each webhook and email action is stored as *pending*. The delivery loop claims due deliveries with `FOR UPDATE SKIP LOCKED` and a two-minute reservation, sends them, and records the answer.
   * A run is *Done* when every action succeeded, and *Failed* when any action failed for good.
   * While a webhook or email is waiting, the run is *Sending*.

The runner runs inside the API process. Tests set the interval to 0 and call `tick()` themselves, with a chosen clock for schedules (`tick({ now })`).

## Emails

* **Sending.** Plain text over SMTP with nodemailer, one connection per message, through the organisation's own mail server and sender set up in **Settings → Integrations** ([`INTEGRATIONS.md`](INTEGRATIONS.md)), or the server's `SMTP_URL` and `EMAIL_FROM` as a fallback. Without either, email actions fail with "Email is not set up", and the builder and workflow page say so and link to the page.
* **What is sent.** When the run starts, the addresses, subject and message are worked out and kept with the action, so every attempt sends the same email and the run log shows exactly what went:
  * amounts are written for people, such as `₹1,50,000.00` (Indian grouping for rupees) or `USD 1,234.50`, and dates as `2 Nov 2026`;
  * emails to members end with the automation's name, the organisation and a link to the record (`APP_URL`);
  * emails to a customer or vendor end with "Sent by <organisation>" and no link into the app.
* **Who it goes to.**
  * *A role:* every member with that role, in one email (up to 50 addresses).
  * *One member:* their account's email. If they have left, the action fails.
  * *The customer or vendor:* the email saved on the contact. If there is none, that action fails with "<name> has no email address"; other actions still happen.
* **Headers.** `Auto-Submitted: auto-generated`, `X-Auto-Response-Suppress: All`, and a Message-ID that is the same on every attempt of one delivery.
* **Retries.** The same schedule as webhooks (1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours; six attempts). No answer, or a 4xx answer (such as 451, try later), is tried again; a 5xx answer (such as 550, no such mailbox) ends the delivery. An owner or admin can send a failed email again from the run log once the cause is fixed. If some addresses are refused and the rest accepted, the email counts as sent and the refused addresses are listed.
* **Tests.** "Test and email me" (or "Test and send") sends each email to the person testing only, with `[Test]` in front of the subject and a first line saying who the real email would go to. Customers and vendors never receive test emails.

## Webhooks

* **The request.** A `POST` with `content-type: application/json` and this body:

  ```json
  {
    "id": "<delivery id>",
    "event": "INVOICE_POSTED",
    "test": false,
    "occurredAt": "…",
    "organizationId": "…",
    "workflow": { "id": "…", "name": "…", "version": 2 },
    "entity": { "type": "document", "id": "…" },
    "data": { "number": "INV-000002", "contactName": "…", "total": "150000.00" }
  }
  ```

* **Headers:**
  * `t2t-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, using the workflow's signing secret (`whsec_…`);
  * `t2t-event`;
  * `t2t-delivery`, the same on every retry of one delivery, so a receiver can ignore repeats;
  * `t2t-attempt`.

  The body is byte-for-byte the same on every attempt. Receivers should check the signature, and that `t` is recent, before trusting a delivery.
* **Signing secret.** Owners and admins see the secret on the workflow page. **New secret** replaces it at once, and is recorded in the audit trail.
* **Answers:**
  * Any 2xx answer is success.
  * Redirects are **not followed**; they count as a failure that is not retried.
  * There is a timeout of `WEBHOOK_TIMEOUT_SECONDS` (default 10).
  * The first 500 characters of the answer are kept in the run log.
* **Retries.** Network errors, timeouts, 408, 429 and 5xx answers are retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours: six attempts in all. Other answers end the delivery at once.
  * An owner or admin can **send a failed webhook again** from the run log, which makes one more attempt. A delivery can be tried at most 20 times in all.
* **Private networks are refused.** In production a webhook must go to a **public https address**.
  * Addresses that are, or resolve to, loopback, private, link-local (including cloud metadata at 169.254.169.254), carrier-grade NAT, documentation, multicast or reserved ranges are refused. This includes IPv4-mapped IPv6 forms such as `[::ffff:7f00:1]`.
  * Host names are resolved when the webhook is sent, every address returned is checked, and the connection is made to the checked address. A name therefore cannot be pointed at a private address between the check and the request.
  * `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` lifts this, and allows `http://`, for local development and tests only.

## Building, testing and changing a workflow

* **A new workflow starts off.**
* **Test.** **Test** runs the workflow as a dry run on:
  * for an event trigger, the most recent real event it listens to (or a chosen event id);
  * for a schedule, the latest time it came round, with today's figures;
  * for "an invoice is overdue", the most recently overdue invoice still to be paid; for "a bill is due soon", the next bill to fall due that is still to be paid.

  It shows the facts, each condition with whether it holds and the actual value, and the exact task and email each action would make. Nothing is created. **Test and send webhooks** (or **Test and email me**, **Test and send**) also sends each webhook once, with `"test": true`, and each email to the tester only. Test runs are kept in the run log, marked *Test*.
* **Versions.** A change to the trigger, its settings, the conditions or the actions makes a **new version**.
  * Versions are never changed or deleted (database trigger).
  * Each run keeps the version it ran.
  * The editor sends the version it started from, so two people editing at once cannot overwrite each other (`409 WORKFLOW_CHANGED`).
  * A change to the name or description alone keeps the version.
* **Turning off** stops new runs. Webhooks already queued are still sent.
* **Workflows are never deleted.** Turn them off instead; their run log stays.

## Tasks

| Who | Can |
|---|---|
| Members with `tasks.use` (everyone except Employees) | See tasks for them or their role, and tasks they created; create tasks for a member or a role; mark done or cancel (with a note) tasks for them, for their role, or that they created |
| Owners and admins (`workflows.manage`) | See and close every task |

* Tasks show:
  * who they are for and the due date;
  * **Overdue**, in India time;
  * a link to the record (invoice, bill, receipt, payment, journal, expense claim or alert);
  * the automation that made them, if any.
* A closed task is never changed, and tasks are never deleted. Both are enforced by a database trigger.
* `task.created` (actor empty when an automation made it), `task.completed` and `task.cancelled` go to the audit trail.

## Permissions and audit

| Action | Permission |
|---|---|
| Everything under Automations: build, test, turn on or off, see runs, retry, signing secret, emails to customers and vendors | `workflows.manage` (Owner, Admin) |
| Tasks | `tasks.use` (Owner, Admin, Accountant, Approver, Viewer) |

The audit trail records:

* `workflow.created`, `workflow.updated` (with version and note), `workflow.turned_on`, `workflow.turned_off`, `workflow.tested`, `workflow.secret_rotated`, `workflow.action_retried`;
* the task events above;
* `alert.opened`, which is new: the alert checks now record each alert they open or reopen, so automations can act on it.

## Database guards

All six tables have row-level security by organisation (forced).

* **`workflows`:**
  * CHECKs: a name; version ≥ 1; a secret of at least 32 characters; on implies a starting event.
  * A trigger keeps the organisation, author and creation time, and the version only goes up.
  * Workflows are never deleted.
* **`workflow_versions`:**
  * CHECKs: a known trigger; settings only on schedule triggers (a frequency for schedules, days for date triggers); condition and action lists of the right size; action types task, webhook or email (on actions).
  * Never changed or deleted.
* **`workflow_runs`:**
  * CHECKs: a test run has a tester; a live run has an event or an occurrence, never both; *Sending* exactly when not finished; a failure has a reason.
  * Unique per workflow and event, and per workflow and occurrence, for live runs.
  * Never deleted.
  * Only a running run changes, once. A failed run goes back to running only for a retry.
  * What it ran on (facts, conditions, version, event or occurrence) never changes.
* **`workflow_action_runs`:**
  * An action keeps what it was asked to do.
  * A finished action never changes, except that a failed webhook or email goes back to pending on a retry.
  * Attempts only go up.
* **`workflow_cursors`:** only move forward.
* **`tasks`:**
  * CHECKs: for a member or a role, never both; a known role and link type; closed exactly when not open.
  * Closed once; never deleted.

## Not supported yet (do not rely on these)

* **No other "became true" triggers.** "Bank balance below X" and similar are not triggers. Alerts cover some of these: use **An alert opens**, or a schedule with a condition on its figures.
* **No branches, loops, waits or parallel paths.** One list of conditions, then the actions in order. No reminder sequences (use one workflow per step, such as 3, 10 and 30 days overdue).
* **Email is plain text only, and not yet checked against a real mail provider.** It has been tested end to end against a local SMTP server. No HTML, attachments (such as the invoice PDF), reply tracking, bounce handling, unsubscribe or per-contact opt-out. No SMS or chat; use a webhook to a chat service.
* **No actions that change the books.** No posting, approving, sending invoices, AI agent steps or general API calls; tasks, emails and webhooks only.
* **No custom webhook headers or bodies, and no signing secrets per address.** The body and headers are fixed.
* **The runner is in the API process.** It needs a running API. There is no separate worker, queue or dead-letter view beyond the run log. A schedule missed while the API was down acts once, at the next pass.
* **Not tested at volume.** The runner reads 200 events per organisation per pass, starts up to 200 date-trigger runs per workflow per pass, and sends 20 deliveries per pass. It has not been load-tested.
* **No notifications for tasks.** Tasks have no email reminders of their own, comments, attachments, reassignment or count in the navigation yet. An automation can email the people a task is for.
* **Facts are read at run time.** A record changed between the event and the run (normally a few seconds) is read as it is then. Payments, posted documents and journals do not change after posting, apart from being voided.
