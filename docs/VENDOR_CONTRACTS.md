# Vendor contract compliance (AP-032)

Purchases → **Vendor contracts** records the contracts agreed with vendors and checks every posted bill against the contract that covers its date.

## A contract

- Vendor, title, the vendor's reference, start and end dates (one contract per vendor at a time; terms may not overlap).
- Payment terms in days (optional), a spend cap (optional) and "contract items only".
- A price list: one unit price per item, keyed by HSN/SAC code or, when no code is given, by the description in lower case with punctuation ignored (the same key as Supplier negotiation).
- Terms are fixed once recorded. A contract can be terminated early with a reason and a last day; it cannot be deleted. Both are in the audit trail (`vendor_contract.created`, `vendor_contract.terminated`).

## Checks (engine `contract-compliance.ts`)

| Code | Severity | Raised when | Amount |
| --- | --- | --- | --- |
| PRICE_ABOVE | High | A line's unit price (converted at the bill's exchange rate) is above the contract price for the item | Excess × quantity |
| OVER_CAP | High | Spend under the contract (subtotals before tax, in order of bill date) goes above the cap: that bill and every later one | What the bill adds above the cap |
| SHORT_TERMS | Medium | The bill is due sooner than the contract's payment terms | — |
| OUTSIDE_TERM | Medium | A bill dated after the contract ended or was terminated (within a year), with no other contract of the vendor covering it | — |
| NOT_IN_CONTRACT | Low | With "contract items only", a line whose item is not on the price list | — |

Bills dated before a contract starts are not checked against it. Contract prices are in the organisation's currency.

## API

- `GET /v1/orgs/:orgId/purchases/vendor-contracts`: summary, contracts and all findings, most serious first (purchases.read).
- `GET /v1/orgs/:orgId/purchases/vendor-contracts/:id`: one contract with prices and findings (purchases.read).
- `POST /v1/orgs/:orgId/purchases/vendor-contracts`: record a contract (purchases.manage). Errors: `VENDOR_NOT_FOUND`, `OVERLAPS` (409), ends before it starts, an item priced twice, items-only without items.
- `POST /v1/orgs/:orgId/purchases/vendor-contracts/:id/terminate` `{ reason, date? }` (purchases.manage). The date must fall within the term; `ALREADY_TERMINATED` (409).

Nothing here changes the books or contacts the vendor. Not built: reading contract PDFs, approval workflows for contracts, and blocking a bill at entry.

## Tests

- `packages/accounting-engine/test/contract-compliance.test.ts`
- `apps/api/test/vendor-contracts.e2e.test.ts`
- `apps/web/e2e/vendor-contracts-flow.test.mjs`
