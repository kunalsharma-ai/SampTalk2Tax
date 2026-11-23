# Tax audit preparation (TAX-051)

**Tax → Tax audit preparation** shows what is left to do before a financial year's books go to the
tax auditor, and keeps the preparer's notes for the auditor. It is worked out from the books each
time the page is opened; nothing is guessed.

## Checks

| Check | Form 3CD | Missing when | Needs attention when |
| --- | --- | --- | --- |
| Months of the year locked | | No periods, or any month open after the year ended | Months open while the year is in progress |
| Year closed to retained earnings | | | No active year-end close |
| No drafts dated in the year | | Draft journals or draft invoices and bills dated in the year | |
| Bank accounts reconciled to the year end | | A bank account with statements not reconciled to the year end | Statement lines in the year still unmatched |
| Returns and tax payments for the year | 34, 44 | A return or payment for the year past its due date and not done | Done, but after the due date |
| Acknowledgements and challans on file | | | Done without its acknowledgement or challan (Compliance documents) |
| Cash payments over 10,000 a day | 21(d), 40A(3) | | Any day (from the Tax audit page) |
| Cash received of 2 lakh or more | 31, 269ST | | Any day |
| TDS deposited on time | 34 | | Late or not deposited, with 201(1A) interest |
| Depreciation for the year | 18 | | Fixed assets at cost but no depreciation posted in the year |
| Income tax computation | | Not prepared | Saved but not final, or final and the books changed since |

Checks that do not apply (no bank statements, no GST/TDS/payroll/advance tax set up, no fixed
assets) say so.

## Notes and marking ready

- Anyone with `accounts.manage` can write a note on any check (up to 2,000 characters); an empty
  note removes it. Notes go into the downloaded checklist.
- The year can be marked ready for the auditor once it has ended, nothing is missing, and every
  check needing attention has a note. The checks as they stood are kept with who and when; notes
  are then frozen. If the books change later, the page lists the checks whose status moved.
- Reopening needs a reason (3 to 500 characters) and puts the year back to being prepared.
- Records live in `tax_audit_preparations` (one per organisation and year, never deleted). Notes,
  marking ready, reopening and each export are kept in the audit trail.

## API

- `GET /v1/orgs/:orgId/tax/audit-preparation?year=2025-26` (reports.read; the last year by default)
- `GET /v1/orgs/:orgId/tax/audit-preparation/export?year=2025-26` (reports.read): `{ fileName, csv }`
- `PUT /v1/orgs/:orgId/tax/audit-preparation/:year/notes/:check` `{ note }` (accounts.manage)
- `POST /v1/orgs/:orgId/tax/audit-preparation/:year/ready` (accounts.manage)
- `POST /v1/orgs/:orgId/tax/audit-preparation/:year/reopen` `{ reason }` (accounts.manage)

Errors: `NOT_INDIA` (422), `INVALID_TAX_YEAR` (400), `FUTURE_YEAR` (422), `NOT_READY`,
`PREPARATION_READY` and `NOT_MARKED_READY` (409).

## Not built

Sharing the checklist through the auditor portal, the auditor's own sign-off, Form 3CD clauses
beyond those listed, and filing.
