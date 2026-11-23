# The same receipt file claimed twice (EXP-018)

Every attached file is kept with its SHA-256, so Talk2Tax can tell when the exact file on an
expense claim is also on:

* another expense claim that is submitted, approved or reimbursed (a draft, rejected or void claim
  does not count); or
* a posted supplier bill, meaning the business already paid that receipt directly.

Only the current version of a file that was not removed is compared.

## Where it shows

* **The claim page** shows "Same receipt file elsewhere", with a link to each other claim or bill.
  Only people who may see every claim (`expenses.read`) see it, because it names other people's
  claims. The claimant does not see it.
* **Approving** such a claim needs a note saying why. The API returns
  `SAME_RECEIPT_FILE_NOTE_REQUIRED` without one. The note and the matches are kept with the approval
  in the audit trail (`expense_claim.approved`, `data.sameReceiptFiles`).
* **Unusual expenses** (Expenses → Unusual expenses) raises it as the serious indicator
  `SAME_RECEIPT_FILE`, so the Unusual expense claims alert check raises it too.

## What it does not catch

A new photo or scan of the same paper receipt has different bytes. Those are caught by date and
amount instead: "Possibly claimed before" on the claim and `DUPLICATE_RECEIPT` in the risk view.

## Where it lives

* Engine: `packages/accounting-engine/src/expense-receipt-files.ts` (`sharedReceiptFiles`,
  `describeSharedReceiptFile`) and the indicator in `expense-risk.ts`.
* API: `apps/api/src/expenses/receipt-files.service.ts`, used by `ExpensesService` (claim view,
  approval) and `ExpenseRiskService`.
* Web: `apps/web/src/components/expenses/claim-detail.tsx`.
* Tests: `packages/accounting-engine/test/expense-receipt-files.test.ts`,
  `apps/api/test/receipt-files.e2e.test.ts`, `apps/web/e2e/same-receipt-file-flow.test.mjs`.

No AI model is used.
