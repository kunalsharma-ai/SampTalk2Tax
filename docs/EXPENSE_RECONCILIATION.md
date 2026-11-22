# Expense reconciliation (EXP-016)

Expenses → Expense reconciliation reconciles employee expense claims three ways as of a date
(today when none is given). Nothing is posted and no AI model is used; the logic is in
`packages/accounting-engine/src/expense-reconciliation.ts` and the API is
`GET /v1/orgs/:orgId/expense-reconciliation?asOf=YYYY-MM-DD` (expenses.read).

## Books against claims

Approving a claim credits the Employee Reimbursements Payable account (2250); paying it back or
voiding it debits the account again. The reconciliation compares:

- the account's balance on the date (posted entries dated on or before it, credit less debit), and
- the approved claims still owed on the date: approved on or before it, and neither paid back nor
  voided by then.

Every difference is listed, so the items always add up to it:

- **An entry no claim made**: an entry on the account that is none of a claim's own entries
  (approval, reimbursement or void), such as a balance brought over from another system. Manual
  journals, opening balances and document lines cannot use the account, so this should be rare.
- **A claim whose entries differ**: a claim whose own entries on the account do not come to what
  the claim says is owed on the date.

## What is owed

Each claim still owed, with days since it was approved; over 30 days is overdue. Totals by employee
(with the overdue part and the oldest claim) and by age: 0 to 15, 16 to 30, 31 to 60 and over 60
days.

## Reimbursements and the bank

Each claim paid back in the 90 days to the date is checked against the imported statements of the
bank account it was paid from:

- **Matched on the statement**: the payment's bank line is matched to a statement line.
- **Not on the statement**: unmatched, although the account's statements already run 3 or more
  days past the payment. Match it in Banking, or check that it was really paid.
- **Statement not imported yet**: unmatched, and no statement runs that far yet.
