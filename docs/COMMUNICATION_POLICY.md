# Communication policy and email consent (AR-043)

Email to customers and vendors respects what they asked for and what the organisation allows.

## Rules

`externalEmailDecision` in `packages/accounting-engine/src/communication-policy.ts` decides each email, in this order:

1. **Opted out.** If any recipient is a contact whose latest consent record is OPTED_OUT, the email is refused (`OPTED_OUT`): "X has opted out of email". This applies to every sender, including emails to members whose address is also a contact's.
2. **AI needs a person.** A message drafted by AI goes only after a person approved it (`NEEDS_APPROVAL`). Collection reminders are always AI-drafted and are sent only by a person's Send.
3. **Automations.** When the organisation's policy is BLOCKED, an automation may not email a customer or vendor (`AUTOMATIONS_BLOCKED`). Automations emailing members are unaffected.

## Where it is enforced

- `MailerService.send` asks the policy before every email, so no sender can skip it. A refusal is returned as a failed, non-retryable send: `Not sent: <reason>`.
- Collections: drafting skips customers who opted out ("Opted out of email"). Send checks again just before the email goes, so an opt-out recorded after drafting stops it (409 `OPTED_OUT`). The refusal is audited as `communication.blocked`.
- Automations: a SEND_EMAIL action to the contact is recorded as FAILED with the reason, and nothing is queued.

## Data

- `contact_email_consents` is an append-only history: status, reason (3 to 500 characters), who and when. The latest record is the contact's status; with none, the contact receives email.
- `communication_policies` holds one row per organisation: `automationsToContacts` ALLOWED (default) or BLOCKED.

## API

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/orgs/:orgId/communication-policy` | contacts.read |
| PUT | `/v1/orgs/:orgId/communication-policy` `{automationsToContacts}` | org.manage |
| GET | `/v1/orgs/:orgId/contacts/:contactId/email-consent` | contacts.read |
| POST | `/v1/orgs/:orgId/contacts/:contactId/email-consent` `{status, reason}` | contacts.manage |

Recording the status a contact already has is refused with 409 `NO_CHANGE`. Each change is audited (`contact.email_opted_out`, `contact.email_opted_in`, `communication_policy.updated`).

## Screens

- Customer and vendor pages: the **Email consent** card shows the status and history, and records a change with its reason.
- Governance → **Communication policy** (`/settings/communication`): the automations choice and everyone who opted out.

## Tests

- `packages/accounting-engine/test/communication-policy.test.ts`
- `apps/api/test/communication-policy.e2e.test.ts`: positive and negative cases for automations, collections and the mailer, against real SMTP.
- `apps/web/e2e/communication-policy-flow.test.mjs`

## Not built

Unsubscribe links in emails that customers press themselves, consent for channels other than email (SMS, WhatsApp), and quiet hours.
