# Approval of manual journals (SEC-036)

Owners and admins set an amount on **Approval rules → Manual journals**. From then on, a journal
typed in by hand whose total is at or above that amount posts only after someone else approves it.

- Posting such a journal straight away is refused (`409 JOURNAL_APPROVAL_REQUIRED`): save it as a
  draft and **Ask for approval** on the journal.
- An approver (`approvals.decide`) who neither drafted the journal nor asked approves it, or
  rejects it with a reason. Requests waiting appear on **Approvals → Manual journals to approve**.
- The approval covers the draft exactly as it was: its date, type and every line (a SHA-256
  fingerprint). Editing or deleting the draft withdraws the open request; changing it after
  approval means asking again.
- Each journal has at most one open request (a unique partial index); requests, decisions and
  the policy are kept and audited (`journal_approval*`).

## What is not held

- Journals other modules post (invoices, bills, payments, payroll, assets, allocations ...) follow
  their own approvals (document approval rules, payment batch approval). Pay runs post when someone with payroll and posting rights posts them; they are not held by this rule.
- Journals posted by a journal template's schedule: the template is the standing instruction.
  Approve the template's lines when setting it up.

## API

| Method | Path | Permission |
| --- | --- | --- |
| GET / PUT | `/v1/orgs/:orgId/journal-approvals/policy` | journals.read / org.manage |
| GET | `/v1/orgs/:orgId/journal-approvals?status=PENDING` | journals.read |
| GET / POST | `/v1/orgs/:orgId/journals/:entryId/approval` | journals.read / journals.create |
| POST | `/v1/orgs/:orgId/journal-approvals/:id/approve`, `/reject`, `/withdraw` | approvals.decide (withdraw: the requester) |

## Tests

- `apps/api/test/journal-approvals.e2e.test.ts`
- `apps/web/e2e/journal-approvals-flow.test.mjs`
