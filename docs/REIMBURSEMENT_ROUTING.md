# Reimbursement routing (EXP-026)

Expenses → Reimbursement routing takes the approved expense claims still to be paid, groups them
into one payment per person and routes each payment, saying why. The ready payments can be made in
one step: every claim is reimbursed today through the usual reimbursement journal (Dr Employee
Reimbursements Payable, Cr the bank or cash account). Bank account numbers are never shown.

## Routes

| Route | When |
| --- | --- |
| Bank transfer | The person's employee record (matched by email, ignoring case, not left) has a salary account (number and IFSC), and a bank account has room |
| Pay in cash | No salary account on file, and a cash account has room |
| Wait for cash | No account of the right kind has room after the amount kept and the payments above it in the plan |
| Needs bank details | No salary account on file and no cash account to pay from |

## Order and accounts

- People waiting more than 7 days since their earliest approval come first, then the earliest
  approval, then the smaller amount, then the name.
- Room in an account = its balance − the amount kept in each account − what earlier people in the
  plan take from it. Only active bank and cash accounts in the functional currency count.
- The account a person was last reimbursed from is used while it has room; otherwise the one with
  the most room. A later, smaller payment may still fit where a larger one had to wait.

## API

- `GET /v1/orgs/:orgId/expense-routing?buffer=` — the plan: groups with claims, route, account and
  reason; accounts with what the plan takes and what is left; totals.
- `POST /v1/orgs/:orgId/expense-routing/pay` `{ claimantIds, buffer, reference? }` — works the plan
  out again and reimburses every claim of the chosen people whose route is ready. `409 NOTHING_READY`
  when none of them can be paid.

Both need `expenses.reimburse`. Engine: `routeReimbursements` in
`packages/accounting-engine/src/reimbursement-routing.ts`.
