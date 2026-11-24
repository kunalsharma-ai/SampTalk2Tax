# Tax document interpretation (TAX-043)

Tax → **Tax documents**, for organisations in India and the United States.

Upload a tax document you received as a PDF, or paste its text. Talk2Tax recognises it, says what it is and what to do with it, lists every field it found with the line of text it came from, and checks the figures. Reading is deterministic (`packages/tax-engine/src/tax-document-reading.ts`): no AI model is used, nothing is guessed, and a field that is not found is simply not listed.

| Document | Fields read | Checks |
| --- | --- | --- |
| TDS certificate (Form 16A) | Certificate number, deductor and TAN, your PAN, assessment or tax year, quarter, section, amount paid, tax deducted, tax deposited | PAN is yours; tax not more than the amount paid; the implied rate; less deposited than deducted |
| Annual tax statement (Form 26AS or AIS) | PAN, name, year, and each deductor row (name, TAN, amount paid, tax deducted, tax deposited) | PAN is yours; each row's tax not more than its amount; total TDS against your TDS receivable account for the year (the account chosen on Advance tax) |
| GST challan (PMT-06) | CPIN, GSTIN, date, CIN, IGST, CGST, SGST/UTGST, cess, total | GSTIN valid and yours; heads add up to the total; no CIN means not paid yet |
| US Form 1099-NEC or 1099-MISC received | Form, year, payer and TIN, your TIN, box 1 or box 3 amount, federal tax withheld | Your TIN's last four digits; backup withholding |

- Your PAN is taken from your GSTIN. The year is the tax year on the document, or the year before its assessment year.
- PDFs are scanned, kept encrypted, and limited to 5 MB. Photos and scans have no text: paste the text instead.
- Readings never change and are never deleted. Marking one reviewed (with a note) is final. Reading and reviewing are recorded in the audit trail.
- Permissions: reports.read to see readings; accounts.manage to read a document or mark it reviewed.

The explanations were written from the published forms as known on 24 November 2026 and need review by a tax adviser.

## Evidence

- Engine: `packages/tax-engine/src/tax-document-reading.ts`, tests `packages/tax-engine/test/tax-document-reading.test.ts`
- Data: `tax_document_readings` (migration `20270313100000_tax_document_readings`)
- API: `GET /v1/orgs/:orgId/tax/document-readings`, `POST .../file`, `POST .../text`, `GET .../:id`, `POST .../:id/review`; tests `apps/api/test/tax-documents.e2e.test.ts`
- Web: `apps/web/src/app/orgs/[orgId]/tax/documents/`; browser test `apps/web/e2e/tax-documents-flow.test.mjs`
