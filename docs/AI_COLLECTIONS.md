# AI collections agent (M5 slice 3)

The collections agent drafts payment reminders for customers with overdue invoices, and a person decides whether each one is sent. The figures come from the books. The AI model writes the wording and assesses how likely the customer is to pay. Code checks every amount and invoice number the model writes before anyone can send it.

Screens: **Sales › Collections** (the queue and the review page for each reminder) and **Governance › AI activity** (every AI call). Permission: `collections.manage` (owner, admin, accountant); AI activity needs `audit.read`.

## How a run works

1. A member with `collections.manage` presses **Draft reminders**. It needs a Claude API key, added by an owner or admin in **Settings → Integrations** (or the server's `ANTHROPIC_API_KEY` as a fallback; see [`INTEGRATIONS.md`](INTEGRATIONS.md)) (otherwise `503 AI_NOT_CONFIGURED`), and the organisation must have AI turned on. The copilot's organisation switch is used for this, so one setting covers every AI feature (otherwise `409 AI_OFF`).
2. Customers with posted invoices that are due before today and not fully paid are listed, the largest overdue total first. These customers are left out, and the run lists each with its reason:
   * customers with no email address;
   * customers with a reminder already waiting for review (drafting, to review, or not delivered);
   * customers sent a reminder in the last 7 days;
   * customers beyond the first 20.
3. For each chosen customer, the **facts** are worked out from the books and stored with the draft:
   * every overdue invoice with its days overdue, total and amount still to pay, plus the total;
   * invoices not yet due;
   * the average days late over invoices paid in full in the last 12 months;
   * the last receipt;
   * the last five reminders sent.

   This lives in `packages/accounting-engine/src/collections.ts`.
4. The facts go to the model as plain text, with amounts written the way the email should write them (₹45,000.00).
   * The model must answer with the `submit_reminder` tool: `risk` (LOW, MEDIUM or HIGH), one to four `riskReasons`, a one-line `subject` and a plain-text `body`. `tool_choice` forces the tool.
   * The instructions tell it to use only figures from the facts, to add no fees, interest, deadlines or threats, and to treat customer and invoice text as data.
   * Drafting runs in the background, one customer at a time. Only one run per organisation is allowed at a time (`409 COLLECTIONS_BUSY`). A run cut off by a restart is closed at the next run, and its drafts are marked `INTERRUPTED`.
5. Each draft is checked (`checkDraft`), and the result is stored with it. The checks require:
   * a subject of one line, up to 200 characters, and a message of up to 5,000 characters;
   * that every amount in the text (₹/Rs/INR amounts, grouped numbers, and numbers with two decimals) is one of the customer's invoice totals or balances, the overdue total or the last payment;
   * that every `INV-…` number is one of the customer's;
   * that every overdue invoice is mentioned.

   A refusal, a missing or malformed submission, or a provider error (timeout, rate limit, bad key, overloaded) gives a **Draft failed** reminder with the reason.

## Review and sending

* The review page shows the reminder (editable), the checks, the facts it was written from (with links to the invoices) and the risk with its reasons.
* As the person edits, the checks run again on the server (`POST …/check`, which saves nothing). **Send** stays disabled while a check fails.
* **Approve and send** (or **Send with my edits**) re-runs the checks (`422 DRAFT_CHECKS_FAILED`, with the failing checks) and works the facts out again from the books. If an invoice has been paid or changed since drafting, sending is refused (`409 DRAFT_OUT_OF_DATE`); reject the reminder and draft again.
* The email goes out through the organisation's mail server set up in **Settings → Integrations** (or the server's `SMTP_URL` as a fallback; otherwise `409 EMAIL_NOT_SET_UP`).
  * It is sent to the customer's saved address only, as plain text.
  * It carries a Message-ID of `<reminder id@talk2tax.collections>` and an `X-T2T-Reminder` header.
  * The row is locked while the mail server is talked to, so two people cannot send it twice.
* If the mail server refuses the reminder, it shows **Not delivered** with the answer. **Send again** sends it exactly as approved. Edits sent with a resend are ignored.
* **Reject** keeps the reminder with an optional note. Nothing is sent.
* The reminder keeps both what the model wrote and what was sent, and whether they differ (`edited`).

Every step is in the audit trail:

* `collections.drafting_started` and `collections.drafting_finished`;
* `collections.reminder_drafted` and `collections.drafting_failed` (with the model, tokens and whether the checks passed);
* `collections.reminder_sent` and `collections.reminder_send_failed` (with the recipient, the invoices, the total and the SMTP answer);
* `collections.reminder_rejected`.

## What the database enforces

Migration `20261102180000_collections_agent`, tables `collection_runs` and `collection_drafts`, both with row-level security.

**Runs:**
* Only one run per organisation is open at a time (a unique index).
* A finished run is frozen, and runs are never deleted.

**Drafts:**
* A written draft has the model's text and a risk.
* A failed draft has an error.
* A decision exists exactly when the draft is sent, not delivered or rejected, and a sent reminder has its time.
* Sent, rejected and failed drafts are frozen.
* What the model wrote is written once.
* The customer, address, facts and model never change.
* Drafting only moves to "to review" or "failed", and "not delivered" only to "sent" or "not delivered" again.
* Send attempts only go up, and drafts are never deleted.

## AI activity

`GET /v1/orgs/:orgId/ai-activity` (and the page) lists the newest copilot answers and reminder drafts together. Each row shows:

* what the call was for and who started it;
* the model asked and the model that answered;
* tokens in and out;
* the outcome, the error code, and what a person decided (sent, sent with edits by whom, rejected, not delivered, waiting).

Copilot questions are not shown: they stay private to the member who asked.

## API

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /v1/orgs/:orgId/collections` | collections.manage | `aiConfigured`, `aiEnabled`, `emailReady`, `emailFrom`, `model`, `canChangeAi`, `limits`, `counts` by status, `latestRun` (status, started by, `skipped` with reasons, drafts) |
| `POST /v1/orgs/:orgId/collections/runs` | collections.manage | Start drafting; returns the overview. `503 AI_NOT_CONFIGURED`, `409 AI_OFF`, `409 COLLECTIONS_BUSY` |
| `GET /v1/orgs/:orgId/collections/reminders?status=` | collections.manage | Reminders, newest first, with facts, risk, checks, `canSend` |
| `GET /v1/orgs/:orgId/collections/reminders/:id` | collections.manage | One reminder, with the send log and decision |
| `POST …/reminders/:id/check` | collections.manage | `subject`, `body`: `{checks, passes}`, nothing saved |
| `POST …/reminders/:id/send` | collections.manage | Optional `subject`, `body` (edits; ignored on a resend). `422 DRAFT_CHECKS_FAILED`, `409 DRAFT_OUT_OF_DATE`, `NOT_SENDABLE`, `EMAIL_NOT_SET_UP` |
| `POST …/reminders/:id/reject` | collections.manage | Optional `note`. `409 NOT_REJECTABLE` unless waiting for review |
| `GET /v1/orgs/:orgId/ai-activity?limit=` | audit.read | Rows and totals (calls, tokens) |

## Tests

* `packages/accounting-engine/test/collections.test.ts`: facts from invoices and payments, and every check.
* `apps/api/test/collections.e2e.test.ts` (14 tests): runs with a scripted model and real SMTP to a local server. It covers:
  * no key and AI off;
  * permissions;
  * the facts and request sent to the model;
  * customers left out;
  * checks refusing invented amounts and invoice numbers;
  * sending with edits, once;
  * database guards;
  * out-of-date drafts;
  * rejection and email not set up;
  * a refusal, a bad submission and a rate limit;
  * one run at a time;
  * a 550 then a resend;
  * interrupted runs;
  * the AI activity log.
* `apps/web/e2e/collections-flow.test.mjs`: the real SDK against the local Messages API stand-in (port 4555) and SMTP on port 4556. A wrong amount is caught as it is typed, then fixed, sent and found in the AI activity log.

## Not supported yet

* Not yet run against the live Claude API (no `ANTHROPIC_API_KEY`), nor against a real mail provider.
* There are no reminder sequences, escalation by stage or scheduled drafting runs: a person starts each run. No replies are read or tracked, and nothing is sent by WhatsApp, SMS or post.
* Reminders contain no links or attachments (such as the invoice PDF or a payment link). There is no per-customer opt-out or "do not chase" flag, and no customer-specific tone settings.
* The risk level is the model's assessment from the facts given. It is not a credit score, and it does not change credit limits or terms.
* English only. Up to 20 customers per run.
