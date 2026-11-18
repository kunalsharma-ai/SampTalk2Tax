# Expense policy (EXP-013, EXP-015, EXP-022)

Spending limits and other rules every expense claim is checked against. The checks are plain
rules the organisation sets; there is no AI model behind them.

## Rules

**Expenses → Expense policy** (`/v1/orgs/:orgId/expense-policy-rules`). Finance
(`expenses.reimburse`) adds and changes rules; anyone with `expenses.read` can see them, and
claimants get the active ones, as sentences, with the claim options.

| Rule | Checks | Category |
| --- | --- | --- |
| Limit per receipt (`LINE_MAX`) | each claim line's amount | one or every |
| Limit per day (`DAILY_MAX`) | the claimant's total for a date | one or every |
| Limit per calendar month (`MONTHLY_MAX`) | the claimant's total for a month | one or every |
| Limit per claim (`CLAIM_MAX`) | the claim total | every |
| Receipts required (`RECEIPT_ABOVE`) | a receipt line over the amount on a claim with no attachment | every |
| Receipt age (`MAX_AGE_DAYS`) | how old each line's date is when the claim is submitted | every |

Each rule either **blocks** (the claim cannot be submitted) or **warns** (the claim goes
through, but the approver must give a reason). A limit exactly met is within the policy.
Amounts have no more decimal places than the organisation's currency. A rule keeps what it
checks; its amount, category, severity and active flag can change. Mileage and per diem lines
never need a receipt. Every change is audited (`expense_policy_rule.created` / `.updated`).

Limits per day and per month add up the claimant's **other live claims** (submitted, approved
or reimbursed) as well as this one, so splitting spending across claims does not get around
them. Drafts, rejected and void claims do not count.

## When claims are checked

* **Shown** (draft, rejected, submitted): the claim carries `policy`, a list of
  `{ ruleId, kind, severity, lineNo, message }`. The web app shows it in an "Expense policy"
  card. Once a claim is decided `policy` is `null`; the audit trail keeps what was found.
* **Submitted**: blocking items refuse it with 422 `POLICY_BLOCKED` (`details.issues` holds the
  messages). Warnings are recorded on the `expense_claim.submitted` audit event
  (`policyWarnings`). Receipt age is measured to the submission day.
* **Approved**: the claim is checked again (other claims may have been approved since, and the
  rules may have changed). A blocking item refuses approval with 409 `POLICY_BLOCKED`: reject it
  so the claimant can change it. Any warning needs the approver's note, else 422
  `POLICY_NOTE_REQUIRED`; the note is kept as the decision note and the warnings on the
  `expense_claim.approved` audit event (`policyExceptions`).

## Storage

MongoDB collection `expense_policy_rules` (migration `20261223100000_expense_policy`). The check
itself is `checkExpensePolicy` in `@talk2tax/accounting-engine`.

## Worth a second look (anomaly checks)

Some signs break no rule but are worth a closer look. They are shown on a claim that is still a
draft, rejected or submitted, in a *Worth a second look* card, to the claimant and the approver.
They never block a claim and need no note to approve. Mileage and per diem lines are left out.

| Check | When it shows |
| --- | --- |
| Unusual amount | The line is more than 3 times the median of this organisation's approved and reimbursed lines for the same category in the last 12 months (at least 8 of them, from any claimant). Where those amounts vary, its robust z-score (median absolute deviation) must also be above 3.5. |
| Just under the limit | The line is within 5% below an active per-receipt limit for its category (the tightest one that applies). |
| Split receipts | Two or more lines on the same day and category, each within the per-receipt limit, together go over it. |

The checks are statistical and deterministic: no AI model is involved, and the message gives the
numbers behind each one.

## Tests

* `packages/accounting-engine/test/expense-policy.test.ts`
* `apps/api/test/expense-policy.e2e.test.ts`
* `apps/web/e2e/expense-policy-flow.test.mjs` (screenshots in `talk2tax-preview/expense-policy/`)
* Anomaly checks: `packages/accounting-engine/test/expense-anomalies.test.ts`, `apps/api/test/expense-anomalies.e2e.test.ts`, `apps/web/e2e/expense-anomalies-flow.test.mjs` (screenshot `talk2tax-preview/expenses/expense-anomaly.png`)
