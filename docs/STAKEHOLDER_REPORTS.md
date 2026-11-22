# Executive and investor reports (RPT-022, RPT-023)

Reports → **Executive report** and **Investor report** cover a fiscal quarter (`FY2027-Q2`) or a fiscal year (`FY2027`), named after the year the fiscal year ends in. Each audience has its own report for a period, with its own narrative.

| Section | Executive | Investor |
| --- | --- | --- |
| Headline: revenue with growth on the period before and a year before, gross margin, net income and margin, cash at the end, runway | ✓ | ✓ |
| Summary profit and loss against the period before (the quarter or year before) and the same period last year | ✓ | ✓ |
| Months in the period: revenue, gross profit, net income, cash; receivables and payables at the end | ✓ | ✓ |
| Revenue concentration (largest customer, five largest) | ✓ | ✓ |
| Customers by name | ✓ | never |
| Points for attention | ✓ | — |
| Narrative: highlights, challenges, outlook, decisions needed / asks of investors | ✓ | ✓ |

Points for attention: a net loss (high); revenue down 10% or more on the period before; gross margin down 5 points or more; a runway under 12 months (under 6 is high); one customer with 30% or more of revenue.

Runway is cash at the end ÷ the period's average monthly fall in cash, only when cash fell. Figures come from posted journals (closing entries excluded) and invoiced revenue without tax.

While a report is a draft its figures are worked out from the books every time it is read. Finalising is allowed once the period has ended: it freezes the figures and the narrative; later postings are listed against the frozen copy (`changedSince`). A final report cannot be changed or deleted (collection guards).

The engine is `packages/accounting-engine/src/stakeholder-report.ts` (`reportPeriod`, `periodFor`, `reportMonthsNeeded`, `buildStakeholderReport`). Reports are stored in `stakeholder_reports` (migration `20270218100000_stakeholder_reports`).

## API

- `GET /v1/orgs/:orgId/stakeholder-reports`: suggested periods and saved reports (reports.read).
- `GET /v1/orgs/:orgId/stakeholder-reports/:audience/:period` (reports.read); audience `executive` or `investor`.
- `PUT .../:audience/:period/narrative` `{ highlights, challenges, outlook, asks }` (budgets.manage; audit `stakeholder_report.narrative_saved`).
- `POST .../:audience/:period/finalise` (budgets.manage; audit `stakeholder_report.finalised`).

## Tests

- `packages/accounting-engine/test/stakeholder-report.test.ts`
- `apps/api/test/stakeholder-reports.e2e.test.ts`
- `apps/web/e2e/stakeholder-reports-flow.test.mjs`
