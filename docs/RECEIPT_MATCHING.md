# Receipt-to-transaction matching (EXP-019)

**Expenses → Receipt matching** keeps the receipts for spending paid from a company bank or card
account and matches each to the money-out line of an imported bank statement. Spending a person
paid themselves still goes on an expense claim.

## Flow

1. Anyone who can submit expenses adds a receipt: merchant, date and amount as printed, and an
   optional note. The file (photo or PDF) is an attachment with entity `EXPENSE_RECEIPT`.
2. Finance (banking.read) sees a suggested bank line for each unmatched receipt, scored by
   `suggestReceiptMatches` in `packages/accounting-engine/src/receipt-matching.ts`.
3. Finance (banking.manage) matches one receipt, or all the sure ones together. A receipt needs its
   file before it can be matched. A wrong match is undone with a reason.
4. **Bank spending without a receipt** lists money paid out in the last 30–365 days with no receipt
   matched or attached to the line, with the best unmatched receipt for each.

## Scoring

| Signal | Points |
| --- | --- |
| Same amount / within 2% (charges, tips) | 50 / 25 (otherwise not a candidate) |
| Same day / 1–3 days / 4–7 days / 8–10 days apart | 30 / 20 / 10 / 0 (over 10: not a candidate) |
| A word of the merchant's name in the narration or reference | 20 |

90+ is Sure, 70+ Likely, 50+ Possible. Only money-out lines in the receipt's currency are
considered; each receipt gets one line and each line one receipt, best first. When another line
fits a receipt equally well, it is never Sure.

## API (`/v1/orgs/:orgId/expense-receipts`)

| Route | Permission |
| --- | --- |
| `GET /` (finance: all with suggestions; otherwise your own) | expenses.submit |
| `POST /` | expenses.submit |
| `GET /:id` | expenses.submit |
| `POST /:id/match` `{statementLineId}` | banking.manage |
| `POST /:id/unmatch` `{reason}` | banking.manage |
| `POST /:id/discard` `{reason}` (yours, or finance) | expenses.submit |
| `POST /match-sure` | banking.manage |
| `GET /missing?days=7..365` | banking.read |

Receipts live in `expense_receipts` (migration `20270214100000_expense_receipts`). What a receipt
says never changes, files are fixed once it is matched or discarded, history is only added to, and
receipts are never deleted. Matching does not post anything or change the statement line. Every
step is in the audit trail with the files attached at the time. No AI model is used.

## Not built

Reading the amount from the image (OCR, EXP-004), card feeds (EXP-011), and receipts by email.
