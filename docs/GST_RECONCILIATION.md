# GST reconciliation and tax discrepancy checks (TAX-045, TAX-044)

Tax → **GST reconciliation** (`/tax/gst-reconciliation`): for a month, the GST accounts in the books against what the month's documents say, and the month's documents checked for tax mistakes.

## Reconciliation (TAX-045)

`gstReconciliation` in `packages/tax-engine/src/india/gst-reconciliation.ts`:

- **Documents**: posted invoices, credit notes, bills and vendor credits issued in the month (the GSTR-3B figures). Sales tax goes to the output accounts, input tax credit to the input accounts, reverse-charge tax to both. Credit notes and vendor credits count negative.
- **Books**: movement on the six GST accounts of the registration in posted journals dated in the month (output accounts credit-side up, input accounts debit-side up).
- **GST payments** (and their voids) settle the accounts and are shown apart, not as a difference.
- Every other movement is explained by the entry that made it, so the items add up to the difference:
  - *Journal with no document*: a manual or other journal on a GST account.
  - *Document from another period*: dated in another month, posted in this one.
  - *Earlier document voided*: a void in this month of a document from an earlier month.
  - *Document voided*: a document of this month voided (in this month or later).
  - *Posted in another period*: dated in this month, posted in another.
  - *Posting differs from document*: the journal no longer matches the document's GST lines.

## Discrepancy checks (TAX-044)

`gstDiscrepancies`, on the month's posted documents:

| Check | Severity |
| --- | --- |
| IGST on a supply within the state, or CGST/SGST between states or on an export | High |
| CGST and SGST not equal | High |
| GST on a nil-rated, exempt or non-GST line | High |
| Invalid GSTIN (format, state code, check character) | High |
| Input tax credit on a bill without the supplier's GSTIN (not reverse charge) | High |
| Tax more than ₹1.00 away from the rate on the taxable value | Medium |
| Supplier GSTIN registered in another state than the bill's supplier state | Medium |
| Sales line without an HSN or SAC code | Low |
| One HSN sold at different rates in the month | Low |

Documents are validated when saved, so most of these appear for data that was imported, migrated or changed outside the app. All arithmetic is decimal. Nothing is changed or filed; no AI model is used.

## API

`GET /v1/orgs/:orgId/gst/reconciliation?period=YYYY-MM` (default this month), permission `reports.read`; 409 `GST_NOT_REGISTERED` without a GST registration.

## Tests

- `packages/tax-engine/test/gst-reconciliation.test.ts`
- `apps/api/test/gst-reconciliation.e2e.test.ts`
- `apps/web/e2e/gst-reconciliation-flow.test.mjs`

## Not built

Matching against the GST portal's GSTR-2A/2B (needs the portal integration), and reconciling a quarter or year in one view.
