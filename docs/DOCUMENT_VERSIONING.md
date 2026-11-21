# Document versioning (AUDIT-007)

Every record that takes attached files has an **Attachments** card: bills, invoices, payments, journals, bank lines, expense claims and onboarding.

## Uploading a new version

On a file in use, choose **New version…**, pick the new file and say what changed (3 to 500 characters), such as "Signed copy".

* The new file takes the earlier one's place in the list, with the next version number and the note.
* The earlier file is kept as it was uploaded and can still be opened from the file's history.
* The new file passes the same checks as any upload: at most 5 MB, a PDF, PNG, JPEG or WebP by its bytes, and the file scan. It counts against the plan's uploads.
* A new version must differ from the current one (`SAME_FILE`).
* Only the version in use can be replaced. Uploading over an earlier version gives `NOT_LATEST`, with the id of the version that replaced it.
* You can't replace a removed file (`REMOVED`).
* The rights are the same as for adding a file to that record.

## History

**Versions** on a file lists every version, newest first. Each version shows:

* its number
* who uploaded it, and when
* the note
* whether it is the one in use

Any version in the history can be opened from there. `GET /v1/orgs/:orgId/attachments/:id/versions` gives the same history from any version's id.

## How it is kept

* Each version is its own attachment, with these fields:
  * `version`: 1 for a first upload, and taken as 1 for files stored before this feature
  * `replacesId`
  * `versionNote`
  * `replacedById` and `replacedAt`
* A unique index on `replacesId` means a file is replaced at most once. If two people upload a new version at the same moment, one wins and the other gets `NOT_LATEST`. The history is always a single line.
* Collection guards:
  * A file's version, the file it replaced and its note never change.
  * A file is marked replaced once, and says when.
  * The bytes never change, and no file is deleted. These rules were already in place.
* Earlier versions do not count against the 20 files allowed per record. They are left out of the list and of the "already attached" check.
* Removing a file removes the version in use. Earlier versions stay in its history.
* Each new version is audited as `attachment.new_version`. The audit record holds the version number, both SHA-256 fingerprints and the note.

## Code and tests

* API: `apps/api/src/attachments/` (`newVersion`, `versions`), migration `20270205100000_attachment_versions`, `test/document-versions.e2e.test.ts`
* Web: `apps/web/src/components/attachments.tsx`, `e2e/document-versions-flow.test.mjs`
