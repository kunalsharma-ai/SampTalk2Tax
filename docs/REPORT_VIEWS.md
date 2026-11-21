# Saved report views

The profit and loss, balance sheet, trial balance, cash flow statement and vendor spend reports have a **Saved view** bar (RPT-028, RPT-029, RPT-037).

- **Save view** keeps the filters on screen under a name: the basis, department and project for the profit and loss, and the dates.
- **Dates** are kept as a period relative to the day the view is opened, or as the exact dates chosen:
  - reports over a period: this month to date, last month, this fiscal quarter to date, last fiscal quarter, this fiscal year to date, last fiscal year;
  - reports at one date: today, end of last month, end of last fiscal quarter, end of last fiscal year.
  Fiscal quarters and years follow the organisation's fiscal year start month, and "today" is the organisation's business date.
- **Share with everyone who can read reports** makes the view visible to every member with `reports.read`. Private views are seen only by the person who saved them.
- Choosing a view applies its filters. A view is changed or deleted only by the person who saved it; an owner or admin can also change or delete a shared one.
- A view keeps filters only. It grants no access: the report still shows what the member opening it may see.

Each save, change and delete is in the audit trail (`report_view.saved`, `report_view.updated`, `report_view.deleted`). One person keeps at most 30 views per report.

API (`reports.read`): `GET /v1/orgs/:orgId/report-views?report=`, `POST /v1/orgs/:orgId/report-views`, `PUT` and `DELETE /v1/orgs/:orgId/report-views/:id`. Each view in the list carries `opensWith`, the dates and filters it opens with today.

Tests: `packages/accounting-engine/test/report-views.test.ts`, `apps/api/test/report-views.e2e.test.ts`, `apps/web/e2e/report-views-flow.test.mjs`.
