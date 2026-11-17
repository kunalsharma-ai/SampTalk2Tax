# Unbilled revenue detection (AR-042)

Revenue that was earned or agreed but not yet invoiced, found in the records the app already keeps.
Nothing is estimated by an AI model; each finding says what it rests on. Amounts are before tax, in
the record's own currency.

Where: **Sales → Unbilled revenue**.

## What is looked for

| Source | How sure | Found when |
| --- | --- | --- |
| Milestone completed, not invoiced | Due now | A sales order milestone is marked complete and has no invoice, or its invoice was voided. Amount: its share of the order before tax. |
| Contract period due, not invoiced | Due now | An active contract has periods whose invoice date has come and that were not billed (the contract runner normally bills them; this catches a failed run, with its error). Amount: the period amount for each period due. |
| Draft invoice not issued | Due now | A draft invoice is dated seven days ago or more. Amount: its subtotal. |
| Sales order not fully billed | Likely | A delivery-billed open order dated 30 days ago or more still has quantity to bill (voided invoices free their quantity). Amount: what is left at the order price. |
| Pro forma not turned into an invoice | Likely | An issued pro forma ran out without a tax invoice (or its invoice was voided). Amount: its subtotal. |
| Regular customer not billed last month | Possible | A customer invoiced in each of the three months before last month had no invoice last month (customers already flagged above are left out). Amount: their usual month, in the functional currency. |

Usage recorded after its period was billed cannot happen (usage billing refuses it), so it is not
a source. Thresholds are in `packages/accounting-engine/src/unbilled-revenue.ts`.

## Dismissing

Someone with `sales.manage` dismisses a finding with a reason, such as delivery on hold, and can
bring it back. The amount at the time is stored; if the finding later grows (another contract
period falls due, more to bill), it comes back by itself. Dismissals are kept as recorded: a
database trigger refuses any update or delete, and each is in the audit trail
(`unbilled_revenue.dismissed`, `unbilled_revenue.restored`).

A finding disappears once it is billed.

## API

- `GET /v1/orgs/:orgId/sales/unbilled-revenue` (sales.read): every finding, totals by currency and source, counts.
- `POST /v1/orgs/:orgId/sales/unbilled-revenue/dismissals` (sales.manage): `{ fingerprint, action: DISMISS | RESTORE, reason }`.
