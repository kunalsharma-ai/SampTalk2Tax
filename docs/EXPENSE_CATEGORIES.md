# Expense categories (EXP-005)

Finance keeps the list of categories people claim expenses under (Expenses → Expense categories,
needs `expenses.reimburse`). Each category has:

- a name, unique among active categories (case and spaces ignored);
- the expense account it posts to (postable, active, not a control account);
- optional guidance shown to the employee when they pick it;
- an optional default tax rate (a simple rate with a purchase-tax account);
- a receipt rule: **as the expense policy says**, or **always required**.

## On a claim

Once an organisation has at least one active category, employees (without `expenses.read`) must
pick a category on every receipt line; the server fills the line's account from the category and
keeps the category on the line. Finance may still claim straight to an expense account. Mileage
and per diem lines take their account from their rate, not a category.

A category that always needs a receipt blocks submitting a claim with a line in it until a
receipt is attached. If finance moves a category to another account, drafts in it must be saved
again before they can be submitted (the line then posts to the new account); approved claims keep
their account.

## Limits

Spending limits per category are expense policy rules narrowed to the category's account
(per receipt, per day, per month). The categories page lists the rules that apply to each.

## Records

`expense_categories` (migration `20270227100000_expense_categories`): archived, never deleted;
every create, edit (with what changed), archive and restore is in the audit trail. The page shows
what was claimed in each category over the last 90 days (submitted, approved and reimbursed
claims), for those who can see every claim.

API: `GET/POST /v1/orgs/:orgId/expense-categories`, `PUT /:id`, `POST /:id/archive`,
`POST /:id/restore`. Tests: `apps/api/test/expense-categories.e2e.test.ts`,
`apps/web/e2e/expense-categories-flow.test.mjs`, `packages/accounting-engine/test/expense-categories.test.ts`.
