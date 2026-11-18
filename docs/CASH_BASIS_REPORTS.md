# Cash-basis profit and loss (GL-014)

The books are kept on an accrual basis. The profit and loss can also be shown on a cash basis,
derived from the same posted entries: income and expenses count when money is received or
paid.

**Reports → Profit and loss → Basis: Cash**, or
`GET /v1/orgs/:orgId/reports/income-statement?from=&to=&basis=CASH` (also on the export,
`/reports/export/income-statement?...&basis=CASH`). Without `basis` the report is accrual, as
before.

## What counts, and when

| Source | Counts on a cash basis |
| --- | --- |
| Entries that move a bank or cash account (bank fees, cash sales, spend money, journals to the bank) | their income and expense lines in full, on the entry date |
| Invoices and bills | their income and expense lines × amount paid / document total, on the payment date (payments in the period, allocations not removed) |
| Credit notes and vendor credits applied | on the date applied, both the document settled and the credit note, each in the share applied |
| Expense claims | in full, on the day the employee is paid back |
| Pay runs | each payroll payment (net pay or a statutory due) counts its share of the run: payment / everything the run owes |
| Depreciation, accruals, deferrals, bad debts, other entries with no cash | left out |

Tax is never income or expense, so a half-paid invoice of ₹1,180 (₹1,000 + 18% GST) counts
₹500 of revenue. Closing entries are left out as on the accrual report. Department and project
filters apply to the lines counted.

The response adds `basis`, `accrualNetIncome` (the accrual result for the same period) and
`notInCash` (accrual minus cash net income): income and expenses not yet received or paid,
settled in another period, or with no cash at all.

## Limits

* Payments not yet applied to an invoice or bill (advances) count nothing until applied.
* Voided payments count on neither date; removed allocations count nothing.
* Exchange gains and losses on settlement count only if their entry moves a bank account.
* The balance sheet stays accrual.

## Tests

* `packages/accounting-engine/test/cash-basis.test.ts`
* `apps/api/test/cash-basis.e2e.test.ts` (invoices with tax, bills, credit notes, direct bank
  entries, expense claims, payroll payments, export)
* `apps/web/e2e/cash-basis-flow.test.mjs` (screenshot in `talk2tax-preview/cash-basis/`)
