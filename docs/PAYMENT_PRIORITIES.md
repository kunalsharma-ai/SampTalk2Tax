# Payment priorities (AP-030) and early-payment discounts (AP-029)

Purchases → Payment priorities ranks open bills (posted, in the functional currency) against the
cash in the bank and suggests what to do with each. Nothing is paid or planned on the page: prepare
a payment batch, or plan dates on the payment schedule, to act on it.

## Cash to work with

Active bank accounts' balances, less the amount you choose to keep in the bank, less bills already
in open payment batches.

## Score (0 to 100)

| Factor | Points |
| --- | --- |
| Urgency: over 30 days past due 50, past due 40, due within 7 days 30, within 14 days 15 | up to 50 |
| Vendor importance: share of purchases in the last twelve months, 25% or more 30, 10% 20, 3% 10 | up to 30 |
| Age of the bill: issued over 60 days ago 20, over 30 days 10 | up to 20 |

## Suggested action

- **Already in a payment batch**: left as it is; its amount is kept aside.
- **Blocked: bank details not verified**: a batch cannot pay the vendor until a second person
  verifies the details (AP-027).
- **Pay now**: past due or due within 7 days, highest score first, while cash lasts.
- **Pay on the due date**: due later, in due-date order, while cash lasts.
- **Cash will not cover it**: what is left over.

## Early-payment discounts (AP-029)

When the cash covers every bill, each bill set aside for a due date at least 10 days away is listed
with the discount to ask the vendor for in return for paying now: amount × target annual return ×
days early ÷ 365, rounded down to the paisa (default target 12% a year; changeable on the page). The
cash is already set aside for these bills, so paying them early leaves every other bill covered. If
the vendor agrees, pay the reduced amount and record the discount on a vendor credit.

## API

`GET /v1/orgs/:orgId/payment-priorities?buffer=0&rate=12` needs `reports.read`. Read-only.

Code: `packages/accounting-engine/src/payment-priorities.ts`, `apps/api/src/payment-priorities/`,
`apps/web/src/app/orgs/[orgId]/purchases/payment-priorities/page.tsx`.
Tests: `packages/accounting-engine/test/payment-priorities.test.ts`,
`apps/api/test/payment-priorities.e2e.test.ts`, `apps/web/e2e/payment-priorities-flow.test.mjs`.
