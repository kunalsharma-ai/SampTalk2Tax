# AI bank reconciliation (M5 slice 4)

AI reconciliation suggests what each unmatched bank statement line is. A person decides on every suggestion. The AI model reads the line and the records it could belong to, and proposes one of these:

* ledger lines already in the books that add up to it;
* a receipt or payment against open invoices or bills;
* an entry to one account;
* that it cannot tell.

Code checks every proposal against the books. Nothing is recorded until a person accepts it, and accepting runs through the same matching, receipt and entry code as doing it by hand.

**Where:** **Banking › (account) › AI suggestions**. Activity also shows up under **Governance › AI activity**.

**Permissions:** `banking.read` to see suggestions, `banking.manage` to start a run, accept or dismiss. Accepting also needs what doing it by hand needs: `journals.post` for an entry, and `sales.manage` or `purchases.manage` for a receipt or payment.

**AI switch:** this uses the organisation-wide AI switch on the Copilot page.

## A run

1. **Starting.** **Suggest for unmatched lines** needs `ANTHROPIC_API_KEY` on the server (`503 AI_NOT_CONFIGURED`) and AI turned on for the organisation (`409 AI_OFF`). Only one run per organisation can run at a time (`409 BANK_AI_BUSY`). A run cut off by a restart is closed at the next run, and its lines are marked `INTERRUPTED`.
2. **Choosing lines.** The run takes unmatched, unreconciled lines on the account, oldest first, up to 25. Three kinds of line are left out, each listed with its reason:
   * lines with an exact one-to-one match (same amount within 14 days and nothing else competing); the existing **Match suggested** handles those;
   * lines that already have a suggestion waiting;
   * lines beyond the first 25.
3. **What the model sees for each line.** All of it is worked out from the books and stored with the suggestion (`packages/accounting-engine/src/bank-ai.ts`):
   * the line itself;
   * up to 25 unmatched posted ledger lines on the account within 45 days;
   * up to 25 open invoices (money in) or bills (money out) with their customer or vendor;
   * the accounts an entry may go to: postable and active, and not a bank, cash or control account (receivables, payables, employee claims);
   * the last 15 bank lines a person turned into entries, and the account each went to. This is how the AI picks up how this business books recurring items such as bank charges.

   Candidates are ranked by shared words first, then by closeness in amount and date. The model sees short references (L1, D1, C1, account codes), never database ids.
4. **The model's answer.** The model must answer with the `submit_suggestion` tool (`tool_choice` forces it). It sends an action (`MATCH`, `PAYMENT`, `ENTRY` or `NONE`), the references, the amounts, a confidence (`LOW`, `MEDIUM` or `HIGH`) and a short reason.
5. **The checks** (`checkProposal`):
   * every reference must be one the model was shown;
   * matched ledger lines must add up to the bank line exactly;
   * a receipt or payment goes to one contact's documents of the right kind (invoices for money in, bills for money out), with each amount at most what the document still owes, and the total at most the line. Anything not applied is left on account, as by hand;
   * an entry goes to one of the offered accounts, with a one-line description.

   A proposal that fails a check is kept and shown with the failing checks, but it cannot be accepted. "Cannot tell" is never applied.

   A refusal, a malformed answer or a provider error gives a **No suggestion** row with the reason.

## Accepting and dismissing

* **Accept** applies the proposal in one transaction, through the same code as by hand:
  * a match uses `BankingService.match`;
  * a receipt or payment uses `recordPayment`, which posts the receipt or payment with its allocations and matches it, with the memo "Suggested by AI reconciliation";
  * an entry uses `createEntry`.

  That code checks again that:
  * the line is still unmatched and not excluded or reconciled;
  * the ledger lines are still unmatched;
  * the documents still owe enough;
  * the account is still allowed.

  If the line was dealt with another way since the suggestion, the page says so and Accept is refused (for example `409 LINE_EXCLUDED`). Undoing an accepted suggestion is the normal **Unmatch** on the bank line.
* **Dismiss** keeps the suggestion with an optional note and records nothing.
* The suggestion keeps what the model was shown, what it proposed, the checks and what it created (the payment number, or the journal entry for an entry).
* The audit trail records `bank_ai.run_started`, `bank_ai.suggested`, `bank_ai.suggestion_failed`, `bank_ai.suggestion_accepted`, `bank_ai.suggestion_dismissed` and `bank_ai.run_finished`.

## What the database enforces

Migration `20261102210000_ai_bank_reconciliation` adds `bank_ai_runs` and `bank_ai_suggestions`, with row-level security on both.

**Runs**

* Only one run per organisation can be in progress (a unique index).
* A finished run is frozen, and runs are never deleted.

**Suggestions**

* A bank line has at most one open suggestion (a unique index on drafting or ready).
* A proposal has an action, what the model sent, a confidence and a reason.
* A failed suggestion has an error.
* Only a proposal that passed its checks, and is not "none", can be accepted, and it must record what it created.
* A decision exists exactly when the suggestion is accepted or dismissed.
* What the model was shown, and what it proposed, never change.
* Accepted, dismissed and failed suggestions are frozen.
* Nothing is deleted.

## API

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /v1/orgs/:orgId/banking/accounts/:accountId/ai` | banking.read | `aiConfigured`, `aiEnabled`, `model`, `canChangeAi`, `limits`, `counts` by status, `latestRun` with lines left out and why |
| `POST /v1/orgs/:orgId/banking/accounts/:accountId/ai/runs` | banking.manage | Start a run; returns the overview. `503 AI_NOT_CONFIGURED`, `409 AI_OFF`, `409 BANK_AI_BUSY` |
| `GET /v1/orgs/:orgId/banking/accounts/:accountId/ai/suggestions?status=` | banking.read | Suggestions, newest first: line, action, resolved proposal, confidence, reason, checks, `canAccept`, `lineOpen`, how much was shown, decision, result |
| `GET /v1/orgs/:orgId/banking/ai-suggestions/:id` | banking.read | One suggestion |
| `POST …/ai-suggestions/:id/accept` | banking.manage (plus what doing it by hand needs) | `409 NOT_ACCEPTABLE` (not waiting, failed its checks, or "none"); errors from matching by hand, such as `LINE_EXCLUDED` and `ALREADY_MATCHED` |
| `POST …/ai-suggestions/:id/dismiss` | banking.manage | Optional `note`. `409 NOT_DISMISSABLE` unless waiting |

## Tests

* `packages/accounting-engine/test/bank-ai.test.ts` covers every check, the text the model reads (references, no ids) and the ranking.
* `apps/api/test/bank-ai.e2e.test.ts` (10 tests) uses a scripted model that picks references out of the text it is sent. It covers:
  * no key and AI off, permissions, and an account that is not a bank account;
  * what the model is shown: references only, accounts without bank or control accounts, bills only for money out;
  * a line with an exact match left out;
  * a receipt split over two invoices;
  * a deposit matched to two receipts;
  * an entry to bank charges;
  * "cannot tell" and an over-allocated bill refused;
  * a dismissal;
  * the database guards;
  * the next run learning from the accepted entry;
  * a suggestion for a line excluded in the meantime refused;
  * a refusal, a rate limit and one run at a time;
  * the AI activity log.
* `apps/web/e2e/bank-ai-flow.test.mjs` uses the real SDK against the Messages API stand-in on port 4555. It imports a statement, asks for suggestions, accepts a receipt (the invoice is paid and the line matched to RCPT-000001), dismisses an entry with a note, and finds both in AI activity.

## Not supported yet

* Not yet run against the live Claude API (there is no `ANTHROPIC_API_KEY`).
* A person starts each run; there are no scheduled runs or runs after import.
* A suggestion cannot be edited before accepting: dismiss it and match by hand.
* A dismissed line that is still unmatched is asked about again on the next run, which uses tokens again. Match or exclude it by hand to stop that.
* Each accept handles one line at a time; there is no bulk accept.
* Entries go to one account. There is no split across accounts, no GST split, and no tax rate on bank entries.
* There are no transfers between the business's own bank accounts. Lines in other currencies are not handled.
* Learning is limited to showing the model the last 15 entries a person made. There are no saved bank rules.
* English only, up to 25 lines per run.
