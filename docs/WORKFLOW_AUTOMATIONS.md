# Workflow automations and tasks (M5, slice 1)

**Automations** let owners and admins say: *when* something happens in the books, *only if* some conditions hold, *do* these things. A workflow can:

* **give someone a task**, linked to the record it is about;
* **send a webhook**, a signed HTTP POST, to another system such as a CRM, a chat tool or an internal service.

**Tasks** are a shared to-do list. People give tasks to each other, and automations give tasks too. Each member sees the tasks given to them or to their role.

| Part | Where |
|---|---|
| Rules: triggers, facts, conditions, validation, templates, retry schedule | `packages/accounting-engine/src/workflows.ts` |
| Runner and webhook delivery | `apps/api/src/workflows/workflow-runner.service.ts`, `workflow-facts.ts`, `webhook.ts` |
| Workflows: building, versions, testing, run log, retry | `apps/api/src/workflows/workflows.service.ts`, `workflows.controller.ts` |
| Tasks | `apps/api/src/tasks` |
| Web | **Governance → Automations** (`apps/web/src/app/orgs/[orgId]/automations`) and **Overview → My tasks** (`…/tasks`) |
| Database | Migration `20261102120000_workflow_automations` |
| Tests | `packages/accounting-engine/test/workflows.test.ts`, `apps/api/test/workflows.e2e.test.ts`, `apps/api/test/webhook.test.ts`, `apps/web/e2e/automations-flow.test.mjs` |

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

A definition is checked when it is saved, and every problem is listed:

* unknown facts or placeholders;
* the wrong test for a fact;
* an amount or date that is not valid;
* a member who cannot take tasks;
* a webhook address that is not public https.

## How the runner works

1. **Events come from the audit trail.** The audit trail is written in the same transaction as the change it records, so it works as a transactional outbox: an event is seen exactly when its change is committed, and never for a change that was rolled back.
2. **One cursor per organisation.** Each organisation has a cursor (`workflow_cursors`) with the last audit event looked at.
   * Every `WORKFLOW_RUNNER_INTERVAL_SECONDS` (default 10), the runner locks each organisation's cursor with `FOR UPDATE SKIP LOCKED`, so two API processes never handle the same events.
   * It reads up to 200 newer events, starts runs, and moves the cursor forward, all in one transaction.
   * Audit ids are committed in order within an organisation, because appends hold a per-organisation lock until commit. So the cursor can never pass an event that is still to commit.
3. **A run per workflow and event.**
   * A workflow acts only on events **after it was turned on**. Turning a workflow on records the newest event id while holding the organisation's audit lock. Turning it on never replays history.
   * Every event a workflow listens to gets a **run**, including runs whose conditions did not hold (recorded as *Conditions not met*, with each condition's actual value).
   * A unique index allows one live run per workflow and event.
4. **Webhooks are sent after the transaction.**
   * Each webhook action is stored as *pending*. The delivery loop claims due deliveries with `FOR UPDATE SKIP LOCKED` and a two-minute reservation, sends them, and records the answer.
   * A run is *Done* when every action succeeded, and *Failed* when any action failed for good.
   * While a webhook is waiting, the run is *Sending*.

The runner runs inside the API process. Tests set the interval to 0 and call `tick()` themselves.

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
* **Test.** **Test** runs the workflow on the most recent real event its trigger listens to (or a chosen event id), as a dry run. It shows:
  * the facts;
  * each condition, whether it holds, and the actual value;
  * the exact task each action would create.

  Nothing is created. **Test and send webhooks** also sends each webhook once, with `"test": true`. Test runs are kept in the run log, marked *Test*.
* **Versions.** A change to the trigger, conditions or actions makes a **new version**.
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
| Everything under Automations: build, test, turn on or off, see runs, retry, signing secret | `workflows.manage` (Owner, Admin) |
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
  * CHECKs: a known trigger; condition and action lists of the right size.
  * Never changed or deleted.
* **`workflow_runs`:**
  * CHECKs: a test run has a tester and a live run has an event; *Sending* exactly when not finished; a failure has a reason.
  * Unique per workflow and event for live runs.
  * Never deleted.
  * Only a running run changes, once. A failed run goes back to running only for a retry.
  * What it ran on (facts, conditions, version, event) never changes.
* **`workflow_action_runs`:**
  * An action keeps what it was asked to do.
  * A finished action never changes, except that a failed webhook goes back to pending on a retry.
  * Attempts only go up.
* **`workflow_cursors`:** only move forward.
* **`tasks`:**
  * CHECKs: for a member or a role, never both; a known role and link type; closed exactly when not open.
  * Closed once; never deleted.

## Not supported yet (do not rely on these)

* **No scheduled triggers.** Examples are "every Monday" and "3 days before a due date". Triggers fire on events only.
* **No other "became true" triggers.** "Invoice became overdue", "bank balance below X" and similar are not triggers. Alerts cover some of these: use **An alert opens**.
* **No branches, loops, waits or parallel paths.** One list of conditions, then the actions in order.
* **No email, SMS or chat notifications.** Talk2Tax does not send email yet. Use a webhook to a chat or email service.
* **No actions that change the books.** No posting, approving, sending invoices, AI agent steps or general API calls; tasks and webhooks only.
* **No custom webhook headers or bodies, and no signing secrets per address.** The body and headers are fixed.
* **The runner is in the API process.** It needs a running API. There is no separate worker, queue or dead-letter view beyond the run log.
* **Not tested at volume.** The runner reads 200 events per organisation per pass and sends 20 webhooks per pass. It has not been load-tested.
* **No notifications for tasks.** Tasks have no email reminders, comments, attachments, reassignment or count in the navigation yet.
* **Facts are read at run time.** A record changed between the event and the run (normally a few seconds) is read as it is then. Payments, posted documents and journals do not change after posting, apart from being voided.
