# Department budgets (EXP-014)

Expenses → **Department budgets** (`/expenses/department-budgets`): each department's budget for the fiscal year against what it has spent on expenses.

## Departments on claims

Every expense claim line (receipt, mileage or per diem) can name a department, chosen from the active departments under Departments and projects. The server refuses a department that does not exist or is inactive. When the claim is approved, the department is carried onto the expense debit of the journal, so spending by department comes from the ledger.

## Budgets

Finance (`budgets.manage`) sets one amount per department and fiscal year, with an optional note. Setting it again replaces it; each change is written to the audit log (`department_budget.set`, with the amount before and after). Stored in `department_budgets` (unique per organisation, department and year).

## Status

`departmentBudgets` in `packages/accounting-engine/src/department-budgets.ts`:

- **Spent**: debits less credits on expense accounts carrying the department, posted in the fiscal year up to today, closing entries left out.
- **Waiting**: net amounts of submitted claim lines with the department, in the functional currency.
- **Left**: budget less spent less waiting.
- **Year-end pace**: spent scaled from the days of the year gone to the whole year.
- **Over** when spent is above the budget; **At risk** when waiting claims would take it over, or the pace passes the budget; **On track** otherwise; **No budget** when none is set.

An approver opening a submitted claim sees, for each department on it, how much of the budget is left before and after approving. A budget never blocks a claim. All arithmetic is decimal; no language model is involved.

## API

- `GET /v1/orgs/:orgId/expense-departments` (`expenses.submit`): active departments for the claim form.
- `GET /v1/orgs/:orgId/department-budgets?fiscalYear=` (`expenses.read`).
- `PUT /v1/orgs/:orgId/department-budgets` `{departmentId, fiscalYear, amount, note?}` (`budgets.manage`).
- `GET /v1/orgs/:orgId/expense-claims/:claimId/budget-impact` (`expenses.read`).

## Tests

- `packages/accounting-engine/test/department-budgets.test.ts`
- `apps/api/test/department-budgets.e2e.test.ts`
- `apps/web/e2e/department-budgets-flow.test.mjs`

## Not built

Budgets per month or per expense account within a department, bills and payroll in the department's spending (only entries on expense accounts that carry the department count, which includes bills coded to a department), and alerts when a department goes over.
