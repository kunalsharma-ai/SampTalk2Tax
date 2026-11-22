# Expense audit evidence (EXP-027)

Expenses → Expense audit evidence collects, for every expense claim approved, reimbursed or voided
in a period, the evidence an auditor asks for, straight from the records, and shows what is missing.
Nothing is copied or typed in: the pack is collected again each time it is opened, so fixing a gap
on the claim (attaching a receipt, matching a payment on the statement) clears it.

## Evidence

| Evidence | OK when | Otherwise |
| --- | --- | --- |
| Receipts | At least one file on the claim (each with its SHA-256) | Gap |
| Approval | Approved by someone other than the claimant, with the time | Gap |
| Expense policy | Within the policy when approved | Noted when outside it with the approver's note (from the audit trail); gap without |
| Journal entry | The claim's journal entry is posted | Gap |
| Reimbursement | Reimbursed, with date, account and journal | Pending while approved and unpaid; n/a when void |
| Bank statement | The reimbursement is matched on the statement | Gap once the statement runs more than 3 days past the payment; pending before; n/a for cash |
| Audit trail | The approval, and the reimbursement or void, are in the hash-chained audit trail | Gap |

A claim is complete when nothing is a gap.

## Pages and API

- `GET /v1/orgs/:orgId/expense-evidence?from&to&gapsOnly` — claims whose journal date falls in the
  period (default: the 90 days to today; at most 1,000), each with its items, gaps and counts.
- `GET /v1/orgs/:orgId/expense-evidence/:claimId` — one claim's pack: items, receipt files with
  SHA-256 and upload time, and the claim's audit events with their hashes.
- `GET /v1/orgs/:orgId/expense-evidence/export?from&to` — `{ fileName, csv }`: one row per evidence
  item and per receipt file (claim, claimant, status, total, evidence, state, detail, file, SHA-256).
  Values starting with `=`, `+`, `-` or `@` are prefixed with `'` so spreadsheets do not run them.

All need `audit.read`. Engine: `collectExpenseEvidence` and `expenseEvidenceCsv` in
`packages/accounting-engine/src/expense-evidence.ts`.
