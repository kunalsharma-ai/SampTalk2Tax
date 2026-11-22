# Payroll reports (RPT-010)

Reports → **Payroll report** covers the posted pay runs for a range of months. By default it runs from the first month of the financial year to this month, and a range can be up to 24 months.

| Section | What it shows |
| --- | --- |
| Totals | Employees paid, payslips, gross, deductions, net, cost to the employer and the employer's contributions (cost less gross) |
| Pay runs not posted | Draft runs in the period, which the report leaves out |
| Statutory amounts | For each of PF (employee share; employer EPF, EPS, EDLI and admin charges), ESI (employee and employer), professional tax and TDS on salary: what was withheld from employees and what the employer adds |
| Payroll by month | Employees, gross, PF, ESI, professional tax, TDS, net, employer cost and the change in gross on the month before; a change of 10% or more is flagged |
| Payroll by employee | Months paid, gross, amounts withheld, net and employer cost |

The engine is `packages/accounting-engine/src/payroll-report.ts` (`buildPayrollReport`, `payrollReportCsv`). Bank account details are never read or shown, and voided and draft runs are left out.

## API

- `GET /v1/orgs/:orgId/reports/payroll?from=YYYY-MM&to=YYYY-MM` (payroll.read).
- `GET /v1/orgs/:orgId/reports/payroll/export` returns `{ fileName, csv }` (payroll.read). Each export is written to the audit trail as `payroll_report.exported`, and formula-like cells are guarded.

The report is read-only.

## Tests

- `packages/accounting-engine/test/payroll-report.test.ts`
- `apps/api/test/payroll-report.e2e.test.ts`
- `apps/web/e2e/payroll-report-flow.test.mjs`
