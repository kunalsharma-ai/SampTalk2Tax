# Audit reports (RPT-021)

Reports → **Audit report** covers what happened in the books over a period of days, read from the hash-chained audit trail and the posted journals. By default it runs from the first day of the financial year to today, and a period can be up to two years. Days are in the organisation's time zone.

| Section | What it shows |
| --- | --- |
| Totals | Events recorded and the people who recorded them, sensitive actions, journal exceptions, and whether the audit trail hash chain is intact |
| Sensitive actions | Each action an auditor asks about, newest first, with a count for each kind: periods reopened, access changes, bank details changed, deletions, voids, reversals and cancellations, settings changed, and data exported |
| Journal checks | Posted journals that need a second look, most serious first (see below) |
| Activity by person | Events each person (and the system) recorded, and how many were sensitive |
| Activity by record type | Events by the kind of record they changed |

Journal checks on journals posted in the period:

- **Posted long after its date** (high): posted more than 30 days after the journal's date.
- **Large round manual journal** (medium): a manual journal of 1,00,000 or more in whole multiples of 10,000.
- **Prepared and posted by one person** (low): a manual journal posted by the person who prepared it.

Reversing entries are not checked as manual journals; the reversal is already listed as a sensitive action. A broken hash chain is shown as a warning at the top. At most 20,000 events are counted in one report, and the page says when that limit was reached.

The engine is `packages/accounting-engine/src/audit-report.ts` (`buildAuditReport`, `auditReportCsv`, `auditCategory`).

## API

- `GET /v1/orgs/:orgId/reports/audit?from=YYYY-MM-DD&to=YYYY-MM-DD` (audit.read).
- `GET /v1/orgs/:orgId/reports/audit/export` returns `{ fileName, csv }` (audit.read). Each export is written to the audit trail as `audit_report.exported`, and formula-like cells are guarded.

The report is read-only.

## Tests

- `packages/accounting-engine/test/audit-report.test.ts`
- `apps/api/test/audit-report.e2e.test.ts`
- `apps/web/e2e/audit-report-flow.test.mjs`
