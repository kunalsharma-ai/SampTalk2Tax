# Missing receipt detection (EXP-021)

Expenses → Missing receipts (`expenses.read`) lists expense claims submitted, approved or
reimbursed in the chosen period (30 to 365 days) that have receipt lines and no receipt attached,
with why each one matters:

- **Required by policy**: a line is over the lowest active "receipt above" amount in the expense policy;
- **Category needs one**: a line is in an expense category that always needs a receipt (EXP-005);
- **No receipt**: no rule asks for one, but nothing backs the spending.

Mileage and per diem lines are worked out from rates and need no receipt. The page totals the
spending without receipts and groups it by claimant. Bank payments without a receipt are found by
receipt matching (EXP-019).

## Asking for the receipt

Finance (`expenses.reimburse`) asks the claimant with a note: the request is recorded
(`expense_receipt_requests`, migration `20270228100000_receipt_requests`, kept as written), shown
on the claim, emailed to the claimant when the organisation's email is set up, and audited
(`expense_claim.receipt_requested`). The same claim can be asked about again after 24 hours;
claims with a receipt, drafts and your own claims cannot be asked about.

Once asked, the claimant may attach the receipt even on an approved or reimbursed claim, until one
is attached; they cannot remove it afterwards. The request then shows as answered and the claim
leaves the list.

Checks at submission and approval are unchanged: the expense policy and categories decide whether
a missing receipt warns or blocks (see EXPENSE_CATEGORIES.md).

API: `GET /v1/orgs/:orgId/expense-claims-missing-receipts?days=`,
`GET|POST /v1/orgs/:orgId/expense-claims/:claimId/receipt-requests`.
Tests: `packages/accounting-engine/test/missing-receipts.test.ts`,
`apps/api/test/missing-receipts.e2e.test.ts`, `apps/web/e2e/missing-receipts-flow.test.mjs`.
