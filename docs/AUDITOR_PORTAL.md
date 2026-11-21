# External auditor portal (AUDIT-002)

An external auditor can see one internal audit engagement (see [INTERNAL_AUDIT.md](INTERNAL_AUDIT.md)) through a private, read-only link, without an account.

## Giving access

* On the engagement page, under **External auditor access**, an owner or admin (`org.manage`) gives a named auditor access, with an optional firm.
* The link lasts 7, 30 or 90 days, and always expires.
* The link is shown once. Only the SHA-256 of its secret is stored, and lists show only its first 8 characters. The secret is about 238 bits: `t2ta_` followed by 40 letters and digits.
* An engagement can have at most 10 live links.
* Anyone who can see the engagement sees the links: who each is for, when it ends, how many times it was opened, how many files were downloaded, and who withdrew it.
* An owner or admin can withdraw a link at any time. It stops working at once.

## What the auditor sees

* The engagement: scope, objective, lead and reviewer, status, and the conclusion once it is closed.
* The work programme: each step, the work recorded, who did it, and who signed it off and when.
* **Accepted evidence only.** Each item shows its files and their SHA-256 as submitted, and each file can be downloaded. Evidence still requested, or submitted but not yet accepted, is never shown, and its files cannot be opened.
* Linked findings with their plan, due date and status. Linked samples with their seed and testing progress.
* The trial balance at the end of the scope, as the books stand now.
* Nothing else in the organisation can be reached, and nothing the auditor does changes any record.

## Records

* Making and withdrawing links are in the audit trail (`auditor_portal.link_created`, `auditor_portal.link_revoked`). They name the link by its prefix and never record the secret.
* Each file the auditor opens is recorded as `auditor_portal.file_opened`, with the file's name and SHA-256 and no member as the actor.
* The link keeps when it was last opened, how many times it was opened, and how many files were downloaded.
* Links cannot be deleted. A withdrawn link cannot be restored. Who a link is for and when it ends cannot be changed.

## Security

* The portal routes are public and rate-limited per address, like sign-in.
* Responses are sent with `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`.
* A link stops working when it is withdrawn or expires, when the organisation is suspended, or when the request reaches a server in another data region.

## API

* Staff:
  * `GET /v1/orgs/:orgId/audit-engagements/:id/auditor-links` needs `audit.read`.
  * `POST` (to make a link) and `POST /:linkId/revoke` need `org.manage`.
* Portal:
  * `GET /v1/auditor-portal/:token` for the overview.
  * `GET /v1/auditor-portal/:token/files/:attachmentId` to download a file.
  * The web app passes these on through `/api/auditor-portal/*`, which only accepts GET.
