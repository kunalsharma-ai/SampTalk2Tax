# Internal audit workspace (AUDIT-001)

Governance → Internal audit is where internal audits are planned, worked and signed off.

## An engagement

* **Scope.** A name, what the audit sets out to check, and the dates it covers.
* **Lead.** A member who works on the books (audit trail permission). The lead plans the work, links samples and findings, and moves the audit on.
* **Reviewer.** A member who can approve, and not the lead. The reviewer signs off the work and closes the audit.
* The scope, lead and reviewer stay as set when the engagement is started. Engagements are numbered IA-001, IA-002 and so on.

## Stages

1. **Planning.** The lead adds steps to the work programme, each assigned to a member who works on the books. A step cannot be assigned to the reviewer, because nobody signs off their own work. At least one step is needed to start fieldwork.
2. **Fieldwork.** The person a step is assigned to, or the lead, records what they did and found (at least 10 characters), which marks it done. The lead can still add steps. The reviewer can sign off done steps or send one back with what needs more work.
3. **Review.** The lead sends it for review once every step is done and every linked sample is fully tested. The reviewer signs off each step, or sends a step back. The reviewer can send the whole engagement back to fieldwork with a note (at least 10 characters).
4. **Closed.** The reviewer closes it with the conclusion (at least 20 characters) once every step is signed off. A closed engagement is kept as it was closed.

## Samples and findings

The lead links audit samples (AUDIT-009) and audit findings (AUDIT-011) to the engagement. The workspace shows where each one stands now: how far a sample's testing has got, and whether a finding is still open. Findings can stay open after the audit closes, because fixing them is followed up under Audit findings.

## What is kept

* Steps, links and the history are only ever added to. A signed-off step cannot change. The database refuses any change to a closed engagement, and engagements cannot be deleted.
* Every change is also in the audit trail: `audit_engagement.created`, `step_added`, `step_done`, `step_signed_off`, `step_reopened`, `linked`, `moved` and `closed`.

## API

All under `/v1/orgs/:orgId/audit-engagements`, needing `audit.read` (signing off steps needs `approvals.decide`):

* `GET /`, `POST /` to start one, `GET /:id`, `GET /:id/linkable`.
* `POST /:id/steps`, `POST /:id/steps/:stepId/done`, `POST /:id/steps/:stepId/review` (`SIGN_OFF` or `REOPEN`).
* `POST /:id/links` (`SAMPLE` or `FINDING`), `POST /:id/move` (`FIELDWORK`, `REVIEW` or `CLOSED`).
