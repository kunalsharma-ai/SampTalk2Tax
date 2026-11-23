# Bill reader (AP-025)

Purchases → **Bill reader** turns a supplier's bill into a draft bill without typing it in.

## What it reads

* **PDF bills** made by billing or accounting software. The text is read from the PDF itself (`packages/accounting-engine/src/pdf-text.ts`). The reader handles:
  * plain or Flate-compressed content streams and compressed object streams;
  * fonts with a ToUnicode map, as most generated PDFs have, and single-byte (Windows-1252) fonts;
  * text placed anywhere on the page. Each piece of text is positioned, and the page is read top to bottom and left to right, with columns kept apart.
* **Pasted text** of a bill.
* **Photos and scanned PDFs** have no text in them, so they are refused in words. Enter those bills by hand and attach the photo.
* **Password-protected PDFs** are refused, with a request for an unprotected copy.

The bill's fields are found by `extractBill` in `packages/accounting-engine/src/bill-extraction.ts`. It is deterministic: it only takes what is printed on the bill and never invents a figure.

| Field | How it is found |
| --- | --- |
| Supplier | The GSTIN on the bill matched to a vendor's GSTIN; otherwise the vendor's name in the bill's heading; otherwise a "Supplier:"/"From:" label or the first heading line (marked *worked out*) |
| Supplier's GSTIN | The first GSTIN on the bill that is not the organisation's own. Its check character is verified |
| Bill number | "Invoice No", "Invoice #", "Bill No" and similar labels |
| Bill date, due date | "Invoice Date", "Due Date" and similar labels, in day-first numeric dates, ISO dates and written months. A due date can also come from "Net 30" terms (*worked out*) |
| Currency | ₹ / Rs / INR, $ / USD, €, £, AED, SGD, AUD, CAD; otherwise the organisation's currency (*worked out*) |
| Items | The table after a header row naming the item, a quantity or rate, and an amount. Each row gives a description, an HSN/SAC code, quantity × rate = amount, and continuation lines. Without a table, one line carries the amount before tax |
| Totals | Subtotal or taxable value; CGST, SGST, UTGST, IGST, GST, VAT and cess with their rates; round off; and the grand total or amount payable |
| Tax rate | CGST + SGST, or IGST, when the bill has one rate throughout |

**Checks.** The reader says in words when:
* the items do not add up to the subtotal;
* the subtotal plus tax and rounding is not the total;
* the due date is before the bill date, or the bill date is in the future;
* a field is missing;
* the supplier is not a vendor yet, or the GSTIN differs from the one on file or is invalid;
* the same bill from that vendor is already in the books;
* the bill has more than one tax rate;
* the organisation has no tax rate at the bill's rate.

**Suggestions.** Accounts are suggested from the vendor's earlier bills (AP-026 bill coding), or by description. The tax rate is the organisation's active rate at the bill's percentage.

## Reviewing and saving

Opening a reading shows what was found, with each field marked *found on the bill*, *worked out* or *not found*. It also shows the amounts, the checks and the text that was read. Below that is the usual **bill form**, filled in from the bill.

The person corrects the form and saves the bill as a draft or posts it. Saving links the reading to the bill and attaches the PDF to it. The audit event `bill_reading.saved` records what the person changed from what was read (supplier, bill number, dates, currency, total, lines). A reading that is not a bill the organisation owes can be discarded.

Nothing reaches the books until a person saves the bill.

## Storage and security

* Readings are kept in `bill_readings` (migration `20270306100000_bill_readings`). They are never deleted, and what was read never changes.
* The PDF is stored encrypted with the file vault (SEC-011).
* Uploads are at most 5 MB and pass the file scanner (SEC-018/019).
* A PDF's streams may not inflate past 40 MB.
* The PDF reader uses no regular expressions on the file's contents.

| Route | Permission |
| --- | --- |
| `GET /v1/orgs/:orgId/purchases/bill-reader`, `GET …/:readingId` | `purchases.read` |
| `POST …/bill-reader/file?fileName=` (PDF bytes as the body), `POST …/bill-reader/text` `{ text }` | `purchases.manage` |
| `POST …/:readingId/link` `{ documentId }`, `POST …/:readingId/discard` `{ reason? }` | `purchases.manage` |

## Tests

* `packages/accounting-engine/test/bill-extraction.test.ts` covers:
  * amounts and dates as bills write them;
  * a GST tax invoice, terms with IGST and rounding, a bill without a table, every check, and long or odd input;
  * PDFs built by hand: plain and compressed content, a two-byte font with a ToUnicode map inside an object stream, scans, files that are not PDFs, and encrypted PDFs.
* `apps/api/test/bill-reader.e2e.test.ts` covers:
  * a pdfkit PDF read end to end;
  * linking the saved bill, with the PDF attached and the changes audited;
  * duplicates, the suggested tax rate, pasted text and discarding;
  * refusals for photos, other files, scans and empty text;
  * permissions and tenant isolation.
* `apps/web/e2e/bill-reader-flow.test.mjs` uploads a PDF in the browser, checks what was found, saves the bill from the prefilled form (with the PDF attached), and reads and discards pasted text.

## Limits

* Scans and photos need optical character recognition (or an AI model reading the image), which is not built yet. They are refused in words rather than guessed.
* Fonts without a character map (rare in generated PDFs) cannot be read reliably and are refused in words.
* Bills that print the month before the day (US style) are read day-first.
