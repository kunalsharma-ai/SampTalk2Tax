# AI copilot (M4, slice 5)

The **copilot** lets members ask questions about their books in plain language. For example: "How did we do last month?", "Who owes us the most?" or "Will cash stay above the minimum?"

* **The model:** Anthropic's Claude (`claude-opus-5-5` by default), called through the official TypeScript SDK.
* **Where the figures come from:** the copilot never computes or recalls figures itself. It calls **read-only tools**, and these run the same services as the reports in the app. Every answer lists the reports it looked at, each linking to the same figures in the app.
* **What it cannot do:** it cannot post, change, approve, file, pay or send anything.

| Part | Where |
|---|---|
| API | `apps/api/src/copilot`: provider (`copilot.model.ts`), tools (`copilot.tools.ts`), conversations and the tool loop (`copilot.service.ts`), routes (`copilot.controller.ts`) |
| Web | **Overview → Copilot** (`apps/web/src/app/orgs/[orgId]/copilot`) |
| Database | Migration `20261102090000_ai_copilot` |
| Tests | `apps/api/test/copilot.e2e.test.ts`, `apps/web/e2e/copilot-flow.test.mjs`, and the stand-in for the Messages API in `test-support/anthropic-stand-in.mjs` |

## Turning it on

Two switches must both be on before anything is sent to Anthropic.

1. **The server needs an API key.** Set `ANTHROPIC_API_KEY` for the API and restart it.
   * Without the key, the copilot screen says **"The AI copilot is not set up"**.
   * The API answers questions with `503 AI_NOT_CONFIGURED`, and nothing is sent anywhere.
   * Earlier conversations stay readable.
2. **Each organisation must turn it on.** An owner or admin (`org.manage`) turns it on for the organisation. It starts off.
   * Before it is turned on, the screen says what will be sent: each question, and the figures the copilot reads to answer it, including report totals, customer and vendor names and amounts.
   * Turning it on or off is recorded in the audit trail (`copilot.turned_on` and `copilot.turned_off`).

| Setting | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Anthropic API key. Empty means not set up. |
| `ANTHROPIC_BASE_URL` | Anthropic's endpoint | For a gateway or proxy. The browser test points it at the local stand-in. |
| `COPILOT_MODEL` | `claude-opus-5-5` | The Claude model. |
| `COPILOT_MAX_TOOL_ROUNDS` | 8 | The most rounds of tool calls for one question. |
| `COPILOT_TURN_TIMEOUT_SECONDS` | 240 | The longest one answer may take, across all its calls to the model. |

## Who can use it

| Action | Permission | Roles |
|---|---|---|
| Ask questions, read and delete **one's own** conversations | `copilot.use` | Owner, Admin, Accountant, Approver, Viewer (not Employee) |
| Turn the copilot on or off for the organisation | `org.manage` | Owner, Admin |

* **Conversations are private** to the member who started them. Other members of the same organisation cannot see them. This is enforced in the service and again by a restrictive row-level security policy.
* **The tools check permissions too.** Each tool checks the asking member's role before reading. For example, ageing needs `sales.read` or `purchases.read`.
* **Payroll is out of reach.** Payroll and salaries are not available to the copilot at all.
* **Questions are limited.** Each member can ask at most **60 questions an hour** in an organisation (`429 COPILOT_LIMIT`).

## What the copilot can read

There are eleven tools, all read-only, with strict input schemas. Each tool returns the same figures as the matching page. Ids and other machine fields are left out, and each result is capped at 40,000 characters.

| Tool | Reads | Linked page |
|---|---|---|
| `get_dashboard` | Cash, receivables, payables; year-to-date revenue, expenses and net income; each month of the fiscal year | Dashboard |
| `get_income_statement` | Profit and loss for a date range, by account | Profit and loss |
| `get_balance_sheet` | Balance sheet at a date | Balance sheet |
| `get_trial_balance` | Trial balance at a date | Trial balance |
| `get_ageing` | Receivables or payables ageing by customer or vendor, with open items | Receivables or payables ageing |
| `get_kpis` | The 13 KPIs for a month, with formula, components, previous month, last year and target; revenue by customer | KPIs |
| `get_management_report` | The monthly management report, including commentary and whether it is final | Management report |
| `get_cash_forecast` | Cash-flow forecast over 30, 60, 90 or 180 days: totals, cases, lowest point, weekly buckets, largest receipts and payments | Cash-flow forecast |
| `get_budget_variance` | Approved budget against actual for a fiscal year, by month, quarter or year | Budget vs actual |
| `list_alerts` | Alerts by status. This never runs the checks itself. | Alerts |
| `get_compliance_calendar` | Filings and tax payments due in a range, with their status | Compliance calendar |

When a tool fails, its error goes back to the model as an error result, and the answer shows that source as "could not be read". The causes include:

* bad input, such as a date that does not exist or a range given backwards;
* a missing permission;
* a tool the copilot does not have.

## How an answer is made

1. **The question is saved.** `POST …/copilot/conversations` (or `…/conversations/:id/messages`) stores the question and an answer marked **pending**, then returns at once. The answer is worked on in the background. The screen reads the conversation every 1.5 seconds and shows which reports have been looked at so far.
2. **The tool loop runs.** Each request carries:
   * the conversation's stored instructions;
   * the tools, with `strict: true`;
   * adaptive thinking;
   * automatic prompt caching;
   * server-side fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): if the model declines, Anthropic re-runs the request on its recommended fallback model;
   * the member's id as `metadata.user_id`. This is an opaque uuid, never a name or email.

   Requests are streamed, and only the final message is used. Tool calls in one step run in parallel, and their results go back together. This repeats until the model answers.
3. **Each question starts with today's date** in India time, so "this month" and "last quarter" resolve correctly.
4. **How each answer is stored:**

   | Status | When |
   |---|---|
   | `COMPLETE` | The model answered. |
   | `REFUSED` | The model, and its fallback, declined. |
   | `INCOMPLETE` | Too many steps (`TOO_MANY_STEPS`), the answer was cut off (`CUT_OFF`; tools are never run on input that may be cut off), the model returned nothing (`EMPTY`), or the conversation is too long (`TOO_LONG`). |
   | `FAILED` | A provider error with a clear message: `AI_KEY_REJECTED`, `AI_ACCESS_DENIED`, `AI_RATE_LIMITED`, `AI_OVERLOADED`, `AI_UNREACHABLE`, `AI_TIMEOUT`, `AI_REQUEST_REJECTED` or `AI_PROVIDER_ERROR`. An unexpected error is `INTERNAL`, with details in the server log. |

   The member can **ask again**. This puts the question back in the box.
5. **Each answer keeps a record of how it was made:**
   * the reports it looked at (`sources`);
   * the model that actually answered, which can differ after a fallback;
   * the tokens used;
   * the exact messages exchanged with the model.

## Conversations and history

* **Follow-up questions see the whole conversation.** Each earlier exchange that finished is sent again exactly as it was first exchanged, including thinking blocks and their signatures, tool calls and tool results. The history only ever grows by appending. This is what Claude's preserved thinking requires, and it keeps the prompt cache effective.
* **Unfinished exchanges are left out.** An exchange that was refused, failed or incomplete is dropped whole, both the question and the answer.
* **A conversation keeps its starting set-up.** It stores the model, the instructions and the tool-set version it was started with. If the server's model or tool set changes later, the conversation is **closed** for new questions (`409 CONVERSATION_CLOSED`), and the next question starts a new conversation. This way a model never sees a history it did not produce.
* **One answer at a time.** A conversation has at most one answer in progress (`409 COPILOT_BUSY`).
* **Interrupted answers.** If a server restart leaves an answer pending, it is closed as `FAILED` (`INTERRUPTED`) when the next question comes.
* **Deleting.** A member can delete their own conversation. The audit trail keeps `copilot.conversation_deleted` with the title.

## Database guards

* **`copilot_settings`:**
  * one row per organisation (on or off, who changed it);
  * RLS.
* **`copilot_conversations`:**
  * owner, title, model, tool-set version and stored instructions;
  * a trigger keeps the owner, model, tool-set version, instructions and creation time;
  * RLS by organisation, plus a **restrictive policy to the owner** (`t2t_current_user()`).
* **`copilot_messages`:**
  * CHECKs:
    * a question is stored whole and complete;
    * an answer's `completed_at` is set exactly when it is no longer pending;
    * a failed answer has an error code;
    * a complete answer has text;
    * token counts are not negative.
  * A trigger makes **answers start pending**, lets a message change **only while pending**, and keeps its conversation, position and role.
  * RLS by organisation, plus a restrictive policy so that a message is visible only through a conversation the member can see.
* **Audit trail:**
  * `copilot.question_asked` (conversation, length);
  * `copilot.answered` (status, error code, tools used, model, model that answered, tokens);
  * turning the copilot on or off, and deleting a conversation.

## Not supported yet (do not rely on these)

* **Not yet run against the live API.** The copilot has not been used against the live Claude API in this repository, because no key has been provided yet. Everything up to the HTTP call is tested, using the official SDK against a local stand-in. Run a few questions after adding the key.
* **No streaming of the text.** The answer appears whole when it is finished; only the list of reports looked at updates while it works.
* **No document reading** (bills, receipts or PDFs), **no web search**, and **no other organisations' data**.
* **No actions.** The copilot cannot draft journals, invoices, reminders or filings. It answers questions only. AI agents that act, with approval, are later work.
* **No platform admin controls.** There is no screen for choosing the model or tracking spend; the model is set by `COPILOT_MODEL`. There is no per-organisation budget beyond the per-member hourly limit, and no emergency stop apart from removing the key.
* **Answers can be wrong.** The instructions require figures to come from tool results and to name their report, but a language model can still misread a table or make a wrong calculation. The screen says to check figures in the linked reports before relying on them. Tax and legal questions are answered from what the books show, with a suggestion to confirm with the organisation's chartered accountant or tax adviser.
* **English only**, and no voice input.

## Tests

* `apps/api/test/copilot.e2e.test.ts` (19 tests), against real postings. The model is a scripted stand-in.
  * **Not set up:** without a key, the copilot says so and nothing is stored or sent.
  * **Switch and permissions:** off by default; who may turn it on and who may ask.
  * **Tool loop:**
    * tool calls run on real postings, and the results carry the real figures with no ids;
    * the request carries strict tools, adaptive thinking, fallbacks, caching, today's date and the member id;
    * sources, tokens and the audit trail are stored.
  * **History:** a follow-up replays the earlier exchange exactly, thinking signatures included.
  * **Tool failures:** bad dates, ranges given backwards and unknown tools come back as error results.
  * **Every tool:** each tool returns the figures its report shows.
  * **No answer:**
    * refusals are stored and left out of later turns;
    * every provider error maps to its code;
    * the step limit and cut-off answers end the answer as incomplete;
    * a fallback model is recorded as the one that answered.
  * **Busy and deleting:** a busy conversation refuses another question and refuses deletion.
  * **Interrupted answers** are closed when the next question comes.
  * **Privacy:** conversations are private, both through the API and in row-level security.
  * **Closed conversations** refuse new questions.
  * **Hourly limit** per member.
  * **Database tampering** is refused.
  * **Through the official SDK** against a local stand-in for the Messages API:
    * streamed thinking and tool calls;
    * the key and the beta header;
    * thinking signatures replayed;
    * HTTP 401, 429, 529 and 400 mapped to their codes.
* `apps/web/e2e/copilot-flow.test.mjs` (1 test), in the browser. The API runs with `ANTHROPIC_BASE_URL` pointing at the stand-in. The test covers:
  * turning the copilot on, with the notice of what is sent;
  * a question answered from the real profit and loss, with a table and a linked source;
  * a rate-limit error explained, then asked again, with the failed exchange left out of the history;
  * deleting the conversation;
  * turning the copilot off.

The stand-in's replies are written by each test. It is not a model, and the app cannot reach it unless `ANTHROPIC_BASE_URL` is pointed at it.
