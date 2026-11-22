# Tax reports (RPT-009)

Reports → **Tax report** shows the tax in a period (the financial year to date by default, up to two years), from the posted documents and the ledger.

| Section | Source |
| --- | --- |
| Tax by rate | Posted invoices less credit notes (output) and bills less vendor credits (input): taxable value and tax at each rate, net = output − input. GST heads (CGST, SGST, IGST) when documents carry them. |
| Tax by month | The same output, input and net by month of the document date. |
| Tax withheld by section | TDS on bills and TCS on invoices by section, with the base and the number of documents. |
| Tax accounts in the ledger | Every tax payable, tax receivable and tax expense account: balance before the period, debits and credits in it, balance at the end (debit positive). |

Foreign-currency lines count at their document's exchange rate, rounded to the currency. Reverse-charge tax on bills is shown with the input tax stat. Drafts and voided documents are left out. The engine is `packages/accounting-engine/src/tax-report.ts` (`buildTaxReport`, `taxReportCsv`).

## API

- `GET /v1/orgs/:orgId/reports/tax?from&to` (reports.read).
- `GET /v1/orgs/:orgId/reports/tax/export?from&to` returns `{ fileName, csv }` (reports.read). Each export is written to the audit trail as `tax_report.exported`. Formula-like CSV cells are guarded.

Read-only: nothing here changes the books.

## Tests

- `packages/accounting-engine/test/tax-report.test.ts`
- `apps/api/test/tax-report.e2e.test.ts`
- `apps/web/e2e/tax-report-flow.test.mjs`
