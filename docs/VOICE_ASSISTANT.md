# Voice assistant and confirmed actions

The [copilot](AI_COPILOT.md) can now be spoken to. It can also propose three actions, and an action happens only when the member who asked confirms it on screen.

**Overview → Copilot** (`/orgs/:orgId/copilot`).

## Asking by voice

* Press **Speak** and say the question. The words appear as they are heard. When you stop, the question is sent.
* Your **browser** turns speech into text, using the Web Speech API in English (India).
  * In Chrome and Edge, this uses the browser maker's speech service.
  * Talk2Tax never receives audio, only the text, and the page says so under the question box.
* Browsers without speech recognition, such as Firefox, show the button disabled with the reason.
* A spoken question is stored with `channel = VOICE` and marked **Spoken** in the conversation. The audit event `copilot.question_asked` records the channel.
* The model is told the question was spoken ("(Asked by voice.)"), so:
  * it checks names and figures that may have been misheard before acting on them;
  * it answers in short sentences that read well aloud.
* **Read spoken answers aloud** (on by default, remembered in this browser) reads the answer to a spoken question using the browser's speech output, with the markdown removed. Typed questions are never read aloud.

## Actions that need confirmation

The copilot still only reads the books. It can now also **propose**:

| Action | Needs | Sensitive |
| --- | --- | --- |
| Create a task, for the member asking or for a role, with an optional due date (`propose_task`) | `tasks.use` | No |
| Acknowledge an open alert, with an optional note (`propose_alert_update`, ACKNOWLEDGE) | `alerts.manage` | No |
| Dismiss an alert as not a problem, with the member's reason (`propose_alert_update`, DISMISS) | `alerts.manage` | Yes: it stays dismissed when the checks find it again |

### How it works

* **Proposing.** A proposal is checked when it is made:
  * the member must have the permission;
  * the alert must exist and be in a state that allows the change;
  * a dismissal needs a reason, and the model is told to ask the member for one, never to invent it.

  The proposal is then stored with what it will do in words, for example *Create a task "Call Lotus Retail" for you, due 2026-11-07.* The model is told that nothing has been done and that it must not say otherwise.
* **The card.** Under the answer, a card shows the proposal with **Confirm** and **Cancel**. A sensitive action asks a second time ("Confirm this sensitive action?").
* **Confirming.**
  * Only the member who asked can confirm. Anyone else gets 404.
  * It must happen within **15 minutes**; after that the proposal is recorded as expired.
  * It must be done on screen. **Speech can never confirm an action.**
* **Carrying it out.** On confirmation:
  * the member's permission is checked again, as they are now;
  * the action is carried out as them, in the same database transaction that records the decision, so it can never happen twice.

  If the record changed in the meantime (for example the alert was already acknowledged), nothing changes and the card says why.
* **Afterwards.** A decided action is a record: a database trigger stops any later change. The next question in the conversation tells the model what became of each proposal, so it never assumes one was carried out.
* **Audit.** Every step is audited: `copilot.action_proposed`, `copilot.action_confirmed`, `copilot.action_cancelled`, `copilot.action_expired` and `copilot.action_failed`. Each confirmed action also writes the usual `task.created`, `alert.acknowledged` or `alert.dismissed`.

## API

* `POST …/copilot/conversations` and `…/conversations/:id/messages` take an optional `channel` (`TEXT` or `VOICE`).
* A conversation now returns `actions`, and each message has its `channel`.
* `POST /v1/orgs/:orgId/copilot/actions/:id/confirm` and `/cancel` (copilot.use; the member who asked only).
  * Confirm returns the action as `DONE` with a link to the result, or as `FAILED` or `EXPIRED` with the reason.
  * Deciding an action that is already decided gives 409 `ACTION_DECIDED`.

The tool set is now version 3, so older conversations are closed for new questions, as with every tool change.

## Database

* `copilot_messages.channel`: TEXT or VOICE (CHECK).
* `copilot_actions`:
  * conversation, the answer that proposed it, member, kind, input, summary, sensitive;
  * status PROPOSED / DONE / CANCELLED / FAILED / EXPIRED, result or error, `expires_at`, `decided_at`.
* CHECKs on kind and status, and `decided_at` is set exactly when the action is decided.
* A trigger allows only the decision to be recorded, and nothing after it.
* Forced row-level security on `org_id`. The rows are deleted with their conversation.

## Limitations

* **Not yet live.** Live answers wait on a Claude key, and speech recognition has not been checked in a real browser with a microphone. Tests replace the browser's speech recognition and speech output with doubles, because headless Chromium has neither.
* **English (India) only.** There are no other languages or accents.
* **Only three actions.** Posting, paying, filing, approving and sending stay out of reach of the assistant.
