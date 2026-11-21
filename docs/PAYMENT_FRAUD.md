# Payment fraud checks (AP-028)

Purchases → Payment fraud checks lists vendor payments with warning signs: payments waiting in open
payment batches (draft or approved), which can still be stopped, and vendor payments recorded in the
last 90 days. Each sign says what it was raised on. It is worked out from the books only: no outside
data and no AI model, and nothing on the page changes the books. Account numbers are never shown.

## Warning signs

| Level | Sign |
| --- | --- |
| High | The vendor's bank account is also an employee's salary account |
| High | Another vendor has the same bank account (spaces, dashes and leading zeros ignored) |
| High | Bank details changed in the 30 days before the payment and not verified since |
| High | Another payment of the same amount to the vendor within 7 days, or the same bill in another open batch |
| Medium | Bank details changed in the 30 days before the payment, verified |
| Medium | The vendor was added in the 30 days before the payment |
| Medium | Over three times the vendor's largest payment in the year before (at least three to compare) |
| Medium | The payment is not set against any bill |
| Medium | The person who changed the bank details in the 30 days before also made the payment or batch |
| Low | Another vendor's name is the same once case, punctuation, spaces and company words (Pvt, Ltd, LLP…) are ignored |
| Low | A round amount of a lakh or more, in whole thousands |

A payment takes the level of its most serious sign. A batch is checked once per vendor, as it will
be paid, on its payment date.

These signs work with the bank-detail controls (AP-027): a batch with unverified or changed bank
details cannot be approved or paid until a second person verifies them.

## API

`GET /v1/orgs/:orgId/payment-fraud` needs `reports.read`. Read-only.

Code: `packages/accounting-engine/src/payment-fraud.ts`, `apps/api/src/payment-fraud/`,
`apps/web/src/app/orgs/[orgId]/purchases/payment-fraud/page.tsx`.
Tests: `packages/accounting-engine/test/payment-fraud.test.ts`,
`apps/api/test/payment-fraud.e2e.test.ts`, `apps/web/e2e/payment-fraud-flow.test.mjs`.
