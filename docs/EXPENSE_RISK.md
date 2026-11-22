# Unusual expenses and fraud risk indicators (EXP-023, EXP-024)

Expenses → Unusual expenses lists expense claims with warning signs, compared across claims and
people and with the year before, and ranks the people who made them. The alert check **Unusual
expense claims** (`UNUSUAL_EXPENSE`, Alerts → Settings) raises an alert for each claim with a
serious or medium sign. Nothing blocks or changes a claim and no AI model is used; the logic is in
`packages/accounting-engine/src/expense-risk.ts`, and the API is
`GET /v1/orgs/:orgId/expense-risk?days=&receiptsFrom=` (expenses permission).

Claims submitted in the period (90 days on the page by default) are checked. Draft, rejected and
void claims are left out, both as claims to check and as claims to compare with. Mileage and per
diem lines are worked out from rates, so only receipt lines are checked.

| Sign | Level | Raised when |
| --- | --- | --- |
| Possible duplicate receipt | High | A receipt line with the same date and amount as a line on another claim, at the same merchant (ignoring case and punctuation), or in the same category when a merchant is missing; by the same person or someone else |
| Split around a limit | High | Receipts on one day and category, each under a per-receipt limit, that together go over it (EXP-022) |
| Unusually large | Medium | Over 3 times the median for the category on approved claims of the year before, with at least 8 to compare (EXP-022) |
| Just under a limit | Medium | Within 5% under a per-receipt limit (EXP-022) |
| Often just under a limit | Medium | The claimant's claims have 3 or more lines just under a limit in the 90 days to this claim |
| Old receipt | Medium | A receipt dated more than 60 days before the claim was submitted |
| No receipts attached | Medium | Receipts of 5,000 or more (or the amount set) with no file attached to the claim |
| Spent on a Sunday | Low | A receipt dated on a Sunday |
| Round amount | Low | A receipt of 1,000 or more in whole hundreds |

A claim takes the level of its most serious sign and a score of 3 for each high sign, 2 for each
medium and 1 for each low. Claims are listed most serious first, then by score and newest.

## People to look at

Each claimant with flagged claims in the period: how many claims they submitted, how many were
flagged, the signs by level, the total score and the total of the flagged claims. Highest score
first. These are signs for a second look, not proof of fraud.

## Alerts

The check looks back 30 days by default (7 to 90) and uses its own receipts amount (5,000 by
default). Claims with a high sign raise critical alerts and those with a medium sign warnings; low
signs raise none. An alert clears by itself once the claim no longer shows a serious or medium sign,
for example after it is rejected or voided, or after the other copy of a duplicate receipt is.
