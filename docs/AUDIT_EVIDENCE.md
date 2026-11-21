# Audit evidence management (AUDIT-003)

Internal audits (see [INTERNAL_AUDIT.md](INTERNAL_AUDIT.md)) ask members for evidence, and check it before the audit is reviewed.

## Asking for evidence

* On the engagement page, the lead asks a member for evidence: what is needed, optional details, and a due date (today or later).
* The person asked must work on the books (audit trail permission) and cannot be the reviewer, because the reviewer accepts evidence.
* Evidence is asked for during planning or fieldwork. Requests are numbered ER-001, ER-002 and so on.

## Providing it

* Governance → Audit evidence lists every request. **Waiting for me** shows the ones you have been asked for and not yet submitted.
* The person asked, or the lead, attaches files on the request (PDF, PNG, JPEG or WebP, up to 5 MB each, scanned like every other file) and submits them, with an optional note.
* Files can be added, replaced with a new version or removed only while the evidence is requested and the engagement is open. Nobody else can add files to the request.

## Checking it

* The lead or reviewer checks submitted evidence. Whoever submitted it cannot accept it.
* **Accept** keeps it as accepted: the request, its files and the SHA-256 of each file at submission can no longer change.
* **Return it** sends it back with what is missing (at least 10 characters). The files can then be changed and submitted again.
* Requests not submitted by their due date show as overdue.
* The engagement cannot go for review or close until every evidence request is accepted.

## What is kept

* The request (what was asked, of whom, by when) never changes. The history is only added to, and requests cannot be deleted.
* Every step is in the audit trail (`audit_evidence.requested`, `submitted`, `returned`, `accepted`). Each event carries the id, name and SHA-256 of every file attached to the request at that moment, hashed into the chain.

## API

* `GET /v1/orgs/:orgId/audit-evidence` (optional `engagementId` and `status`), `POST /` to ask, `GET /:id`, `POST /:id/submit`, `POST /:id/review` (`ACCEPT` or `RETURN`).
* Files use the attachments API with `entityType=AUDIT_EVIDENCE` and the request id.
* Everything needs `audit.read`.
