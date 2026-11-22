# Automatic expense categorisation (EXP-020, AP-020)

While a receipt line on an expense claim or a line on a bill is being typed, Talk2Tax suggests the
expense account it most likely belongs to. The suggestion shows under the account picker with how
sure it is and why. Nothing changes until the person presses **Use**, and nothing is booked here.

## Where it reads from

| Line | Merchant | Earlier lines |
| --- | --- | --- |
| Expense claim receipt | The merchant typed on the line | Lines of approved and reimbursed claims of the last two years (drafts, submitted, rejected and void claims do not count) |
| Bill line | The vendor chosen on the bill | Lines of posted bills of the last two years |

Only postable, active expense accounts are suggested. The receivables, payables and employee
reimbursements control accounts are never suggested.

## How accounts are scored

The engine is `suggestExpenseCategory` in `packages/accounting-engine/src/expense-categorization.ts`.

- **Same merchant or vendor before:** 3 points times the share of that merchant's earlier lines
  that went to the account. Merchant names are compared ignoring case and punctuation. With a
  single earlier line the account gets 1.5 points.
- **A kind of spending:** words such as taxi, Uber, hotel, restaurant, Airtel, broadband, Zoom,
  licence, stationery, rent or audit name a kind of spending. The account whose name fits that
  kind best (for example *Travel*, *Utilities*, *Software and Subscriptions*) gets 2 points.
- **Description words seen before:** each word of the description (three letters or more, not a
  common word like "bill" or "payment") that appears on two or more earlier lines adds 1 point
  times the share of those lines booked to the account.

Accounts with at least 1 point are suggested, best first, at most three. Confidence is **likely**
(high) at 3 points or more, **possible** (medium) at 2, and **a guess** (low) below that.

## API

- `POST /v1/orgs/:orgId/expense-categorization/claim-line` with `{ merchant, description }` needs
  `expenses.submit`.
- `POST /v1/orgs/:orgId/expense-categorization/bill-line` with `{ contactId, description }` needs
  `purchases.read`.

Both return `{ suggestions: [{ accountId, code, name, confidence, because, score }], linesRead }`.
The score is in points, not money.

## Limits

- The rules are fixed and explained. No AI model is called, so suggestions work without keys.
- Bill lines for inventory or fixed assets are not suggested; only expense accounts are.
- A business with no history still gets suggestions from the kinds of spending when its account
  names fit them.
