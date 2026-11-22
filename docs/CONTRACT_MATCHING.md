# Contract-to-invoice matching (AR-041)

Invoices raised by hand to a customer with a contract are matched to the contract they most likely bill. Sales → **Contract matching** (`/sales/contract-matching`).

## How a match is found

`matchInvoicesToContracts` in `packages/accounting-engine/src/contract-invoice-matching.ts`. Only invoices (draft or posted, not void) to a customer who has an active, paused or ended contract, in the contract's currency, dated from the earliest contract start, and not already billing a contract period are considered. Each is scored against each of that customer's contracts:

| Signal | Points |
| --- | --- |
| Share of the contract's lines on the invoice (same income account, closest description by shared words) | up to 55 |
| Total before tax equals the contract's period total | 25 (or 15 when only the prices match) |
| Dated within the contract's term | 20 |

The best contract scoring 50 or more is shown: 80 and over is a strong match, otherwise a possible one. A dismissed invoice and contract pair is not suggested again; the invoice can still match another contract.

## What it says about the period

The contract period whose dates contain the invoice date:

- **Billed twice?**: the contract already billed that period (with the invoice that did). Void one, or dismiss the match if both are right.
- **Next period**: the contract will bill it next. **Count as period N** records the invoice as that period's invoice and moves the contract on, so the billing runner does not bill it again.
- **Earlier periods unbilled**: bill those first.
- **Contract invoice voided**, **Period was skipped**, **Outside the term**: explained in the advice.

Price differences are shown line by line (billed minus contract; negative is under-billed), with lines left off the invoice. Part periods are prorated by the contract, so their prices are not compared.

## API

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/orgs/:orgId/sales/contract-matching` | sales.read |
| POST | `/v1/orgs/:orgId/sales/contract-matching/link` `{documentId, contractId}` | sales.manage |
| POST | `/v1/orgs/:orgId/sales/contract-matching/dismiss` `{documentId, contractId, reason}` | sales.manage |

Link re-checks the match under a lock on the contract and refuses `NO_MATCH` (422), `NOT_NEXT_PERIOD`, `ALREADY_LINKED`, `INVOICE_VOID` and `CONTRACT_NOT_BILLING` (409). It adds an `INVOICE_LINKED` event to the contract's history and audits `sales_contract.invoice_linked`. Dismissals are kept in `contract_match_dismissals` (append-only, migration 20270212100000) and audited as `contract_match.dismissed`.

## Tests

- `packages/accounting-engine/test/contract-invoice-matching.test.ts`
- `apps/api/test/contract-matching.e2e.test.ts`
- `apps/web/e2e/contract-matching-flow.test.mjs`

## Not built

Reading contract terms from uploaded contract PDFs, and a language-model explanation of a match; the matching is deterministic.
