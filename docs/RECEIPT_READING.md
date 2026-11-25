# Receipt reading (EXP-004)

Talk2Tax reads receipts so members do not type what a receipt already says.

## How it works

1. The member picks a photo (JPEG, PNG or WebP) or a PDF on **Receipt matching** (Add a receipt) or
   on a **new expense claim** (Read a receipt into a line). Large phone photos are shrunk in the
   browser first.
2. `POST /v1/orgs/:orgId/receipt-reading?fileName=` (permission `expenses.submit`) checks the file
   (at most 5 MB, type from its first bytes, the upload scanner), then gets its text:
   - **Photos:** OCR with [Tesseract](https://github.com/naptha/tesseract.js) (Apache-2.0) running in
     the API process. The English model (`@tesseract.js-data/eng`, best_int) ships with the API, so
     no receipt leaves Talk2Tax and no key or outside service is needed. One worker reads one image at
     a time; a read is limited to 60 seconds, and a failed worker is replaced.
   - **PDFs:** the PDF's own text layer (`pdfText`). A scanned PDF with no text is refused with a
     request for a photo.
3. `readReceipt` (`packages/tax-engine/src/receipt-reading.ts`) picks out:
   - the merchant (the first name-like line at the top),
   - the date (a line saying "date" first; day first, month first for US organisations; dates after
     today are rejected, and dates that read two ways are marked Check),
   - the total (grand total, amount payable and similar over a plain "total"; without one, the
     largest amount marked as a guess),
   - the subtotal and the tax lines (CGST, SGST, UTGST, IGST, GST, VAT, cess) with their rates, and
     whether subtotal plus tax equals the total within 1.00,
   - the GSTIN, with its check character verified,
   - the currency from ₹/Rs/INR, $, €, £.

   Every value carries a confidence (Read clearly, Check, Guess) and the line it came from, and the
   reading lists warnings to check.
4. The form is filled; the member checks and saves. On Receipt matching the photo is attached to the
   new receipt automatically. Nothing from a reading is saved by itself: only the file scan record and
   a `receipt.read` audit event (file hash, OCR confidence, merchant, date, total, number of warnings).

## Limits

- English text only; handwritten receipts and very faded thermal paper read poorly.
- Line items are not turned into separate claim lines; the total goes on one line.
- The tax rate on the claim line is not chosen from the reading.

## Tests

- `packages/tax-engine/test/receipt-reading.test.ts`
- `apps/api/test/receipt-reading.e2e.test.ts` (OCR on `test/fixtures/receipt-cafe.jpg`, a PDF, refusals)
- `apps/web/e2e/receipt-reading-flow.test.mjs`
