# Expense reports (EXP-017)

Claimed spending in a period, from the lines of expense claims, by:

- **Category**: the expense account each line was claimed to, largest first, with its share.
- **Month**: by the day the expense happened (the line date), not the day it was claimed.
- **Person**: who claimed it.
- **Status**: waiting for approval, approved but not yet paid, reimbursed.
- **Merchant**: the ten largest; names that differ only in capitals or spaces count as one.

Drafts, rejected and void claims are left out: they are not spending. Every figure is a sum of the
lines as claimed (gross, before tax and the input tax), computed by
`packages/accounting-engine/src/expense-report.ts`.

## Who sees what

People with `expenses.read` (owners, admins, accountants, viewers) see everyone's spending and can
filter to one person or one category. People who can only submit claims (employees, approvers
without `expenses.read`) see their own spending, whatever filter they send.

## API

`GET /v1/orgs/:orgId/reports/expenses?from=YYYY-MM-DD&to=YYYY-MM-DD[&status=SUBMITTED,APPROVED,REIMBURSED][&claimantId=][&accountId=]`

## Screen

Expenses → Expense reports (employees: My expense report). Pick the dates and statuses; click a
category or a person to narrow every table to it.

## Not built

- Expense budgets per category or person, and spending against them.
- Download of the report (the general ledger and journal exports hold the posted figures).

## Tests

- `packages/accounting-engine/test/expense-report.test.ts`
- `apps/api/test/expense-report.e2e.test.ts`
- `apps/web/e2e/expense-report-flow.test.mjs`

## Receipts from a phone

On a phone or tablet, every *Attachments* card (expense claims, bills, invoices, payments, journals
and bank lines) has a *Take a photo* button that opens the rear camera directly. It is hidden on a
computer with a mouse, where *Attach files* is used. Before upload, a photo over 1.5 MB, or larger
than 2,000 pixels on its long side, is redrawn at most 2,000 pixels long as a JPEG. This applies
to photos picked with *Attach files* too. A 12-megapixel phone photo comes down from 5 to 15 MB
to a few hundred KB, under the 5 MB limit and still legible. A camera's generic `image.jpg` is
named `receipt-YYYYMMDD-HHMMSS.jpg`. PDFs, small images and anything the browser cannot read are
uploaded unchanged, and the server checks every file as before.

There is no native mobile app; the web app is used in the phone's browser.
