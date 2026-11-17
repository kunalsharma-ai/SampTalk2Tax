# Transfers between own accounts (BANK-007)

Money moved between two of the organisation's own bank or cash accounts shows up as two
statement lines: money out of one account and the same amount into the other. Booking them
separately would record income and an expense that never happened, so Talk2Tax pairs them.

## Detection

`GET /v1/orgs/:orgId/banking/transfers/suggestions` (`banking.read`) looks at unmatched,
unreconciled statement lines of active bank and cash accounts (the latest 2,000) and pairs:

* money out of one account and **exactly** the same amount into a different one,
* at most **3 days** apart.

Each pair is scored: closer dates first, then wording that says transfer (transfer, TRF, self,
sweep, NEFT, IMPS, RTGS, UPI), then the other account named (its code or a distinctive word of
its name). Each line is used in one pair at most. `unique` is false when either line had
another candidate, and the web app then asks for a second look. Every suggestion lists its
reasons.

## Recording

`POST /v1/orgs/:orgId/banking/transfers { outLineId, inLineId }` (`banking.manage` and
`journals.post`) posts one entry dated when the money left: Dr the receiving account, Cr the
paying account, memo `Transfer 1120 … → 1130 …`. It matches the entry's two lines to the two
statement lines, and the audit trail gets `bank.transfer_recorded`. It refuses (422
`INVALID_TRANSFER`) the same account, amounts that differ, a first line that is not money out,
or lines more than 31 days apart. A line already matched, excluded or reconciled is refused as
for any match. Unmatching either line later works as for any other bank entry.

The **Bank accounts** page shows the suggestions in "Transfers between your accounts" with a
Record transfer button.

## Tests

* `packages/accounting-engine/test/bank-transfers.test.ts`
* `apps/api/test/bank-transfers.e2e.test.ts`
* `apps/web/e2e/bank-transfers-flow.test.mjs` (screenshots in `talk2tax-preview/bank-transfers/`)
