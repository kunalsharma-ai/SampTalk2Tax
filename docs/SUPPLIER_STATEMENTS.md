# Supplier statement reconciliation (AP-011)

Suppliers send a statement of account for a period. It shows the opening balance, the invoices,
debit notes, credit notes and payments they recorded, and the closing balance they say you owe.
**Purchases → Supplier statements** checks that statement against your books. The vendor's statement
in the purchases ledger was already in place; this feature adds the reconciliation.

## Entering a statement

1. Choose the supplier and the period.
2. Enter their opening and closing balances.
3. Paste the lines as CSV: date, reference, type, amount.
   - Dates can be YYYY-MM-DD or DD/MM/YYYY.
   - The type is invoice, debit note, credit note or payment (receipt).
   - Amounts may contain commas.
   - A header row is skipped.
4. Check the rows: any row that can't be read is listed before you save.

Copy their figures exactly, even ones you think are wrong. The reconciliation shows the differences.

## Matching

Each line on the statement is matched to a bill, vendor credit or payment in the books for the
period:

1. **By reference** first: their invoice number against the bill's reference or number, and their
   payment reference against the payment's. Case, separators and leading zeros in numbers are
   ignored, so `PM/26-27/0101` matches `PM-26-27-101`.
2. **By amount and date** otherwise: the same amount, with the closest date first. Payments can be up
   to 10 days apart, because transfers land later in their books. Bills and notes can be up to 7 days
   apart.

A document or payment entered and voided within the period cancels itself out. A void of something
entered before the period appears as an item in your books for you to check.

## The difference, explained

Their closing balance less yours is split into five parts, and the parts always add up to the whole
difference:

| Part | What it means |
| --- | --- |
| Different opening balance | Reconcile the earlier period. |
| Lines only on their statement | A bill not entered yet, a payment not recorded, or a credit you don't have. Each comes with what to do. |
| Items only in your books | Usually a payment still on its way, or a bill or credit they don't know about. |
| Matched amounts that differ | For example, a price difference on an invoice. |
| Their statement does not add up | Their lines don't run from their opening balance to their closing balance as entered. |

## Reconciling

- A statement that does not add up can't be reconciled. Correct it as entered first, using
  **Correct the statement as entered**.
- While differences remain, a note is needed saying how each will be settled.
- Once reconciled, the statement is fixed. Statements are never deleted.
- Creating, correcting and reconciling are each audited as `supplier_statement.created`,
  `supplier_statement.updated` and `supplier_statement.reconciled`.

## API

These endpoints are under `/v1/orgs/:orgId/purchases/supplier-statements`. Reading needs
`purchases.read`; every other call needs `purchases.manage`.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `?contactId` | List the statements, with their differences. |
| `POST` | | Enter a statement (`contactId`, `currency?`, `from`, `to`, `theirOpening`, `theirClosing`, `lines[]`). |
| `GET` | `/:id` | Show the statement and its reconciliation. |
| `PUT` | `/:id` | Correct the statement while it is open. |
| `POST` | `/:id/reconcile` with `{ note }` | Mark it reconciled. |

The data is stored in the `supplier_statements` collection (migration `20270225100000`). The rules
are in `packages/accounting-engine/src/supplier-statements.ts`.

## Not built

- Reading a statement from a PDF or email.
- Statements spanning several currencies.
- Creating the missing bill or payment straight from a line.
