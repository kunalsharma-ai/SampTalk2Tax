# Duplicate files across records (DOC-018)

Every attached file has a SHA-256 fingerprint. The same file on one record is refused (as
before). The same file on **another** record is accepted, because shared evidence is often fine,
but it is named:

- **When it is uploaded and listed**: the Attachments card says "The same file is also on …" with
  links to those records. Only records the person may see are named; a claimant is never told
  about a colleague's claim.
- **Duplicate files** (Governance): every file on two or more records, most serious first.

| Risk | When | Why |
| --- | --- | --- |
| Check first | One file on two or more expense claims | The receipt may be claimed twice |
| Check first | One file on two or more bills | The vendor may be paid twice |
| Check | One file on an expense claim and a bill | The cost may be counted twice |
| Usually fine | Anything else, such as a remittance advice on an invoice and its receipt | Shared evidence |

Removing the file from the wrong record (with the reason, as always) takes it off the list. The
rules are in `packages/accounting-engine/src/duplicate-files.ts`.

## API

- `GET /v1/orgs/:orgId/attachments/duplicates` (`reports.read`): `{ summary, items }`.
- Upload and list responses carry `alsoOn` for each file.

## Not built

- Near-duplicate detection (a rescan, a photo of the same receipt, an edited PDF). That needs
  image or text similarity and is left for the AI document work.

## Tests

- `packages/accounting-engine/test/duplicate-files.test.ts`
- `apps/api/test/duplicate-files.e2e.test.ts`
- `apps/web/e2e/duplicate-files-flow.test.mjs`
