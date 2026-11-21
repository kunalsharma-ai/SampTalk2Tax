# Data import

Accounting → **Import data** brings a chart of accounts, customers, vendors and opening balances in from another system or a spreadsheet saved as CSV (UX-009 to UX-012).

## How it works

1. Choose what to import. **Download template** gives the headings; your own sheet usually works as it is, because headings are matched by name and common alternatives ("Account Number", "Customer name", "GST number", "Dr", "Cr" and so on). Columns that match nothing are listed and left out.
2. Choose the CSV file or paste the rows. Comma, semicolon and tab separators are recognised, and up to 2,000 rows are read at a time.
3. **Preview** checks every row against the books as they are, and writes nothing. Each row is marked:
   - **Create**: the row will be added.
   - **Skip**: it is already there, by account code or by contact name (case is ignored). Existing records are never changed.
   - **Fix**: a problem, with its column and what is wrong.
4. **Import** runs only when no row has a problem, and plans the file again on the server first. Rows are created through the same rules as the screens, so every check and every audit entry applies. Each import is also recorded as `data_import.completed` in the audit trail.

## What each import checks

| Import | Checks | Permission |
|---|---|---|
| Chart of accounts | Code format and repeats, type (Asset, Liability, Equity, Revenue or Income, Expense), subtype for the type, parent in the file or the chart, of the same type and a header, no loops. Parents are created before their children. | Manage accounts |
| Customers, vendors | Name and repeats, email, GSTIN (the tax engine's check digit and state), PAN format and agreement with the GSTIN, state code, six-digit PIN code, payment terms in days, credit limit as a decimal amount. | Manage contacts |
| Opening balances | Account code is one that takes an opening balance (postable, active, not a receivables or payables control account, not Opening Balance Equity), debit or credit but not both, decimal amounts with thousands separators allowed. A date is needed. | Post journals |

Opening balances replace the current ones as one opening journal, exactly as when they are typed on the Opening balances page. A difference between debits and credits goes to Opening Balance Equity and is shown in the preview.

Amounts are read as decimals and never as floating point numbers. Thousands separators (both 1,000,000 and 10,00,000) and a currency sign are allowed; negative amounts are not, because a debit or a credit says the side.

## Code

- `packages/accounting-engine/src/data-import.ts`: columns, templates and the three planners (pure).
- `apps/api/src/data-import/`: `GET /v1/orgs/:orgId/imports`, `POST .../imports/:kind/preview` and `POST .../imports/:kind`.
- `apps/web/src/app/orgs/[orgId]/import/page.tsx`: the page.
- Tests: `packages/accounting-engine/test/data-import.test.ts`, `apps/api/test/data-import.e2e.test.ts` and `apps/web/e2e/data-import-flow.test.mjs`.

## Not covered yet

- Excel files (save as CSV first), and updating existing records from a file.
- Items, employees, open invoices and bills. Unpaid invoices and bills are entered as documents, so their ageing and GST are right.
