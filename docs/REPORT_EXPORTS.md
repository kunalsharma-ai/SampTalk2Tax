# Report exports (M6, slice 6)

Every financial report can be downloaded as **CSV**, **Excel (.xlsx)** or **PDF** from an
Export button on its page. The file shows exactly what the screen shows for the same
parameters, because each export calls the same service as the report's screen and JSON endpoint.

| Report | Page | Parameters | Layout |
|---|---|---|---|
| Trial balance | Reports → Trial balance | `asOf`, optional `from`, `includeZero` | landscape |
| Profit and loss | Reports → Profit and loss | `from`, `to`, optional `departmentId`, `projectId` | portrait |
| Balance sheet | Reports → Balance sheet | `asOf` | portrait |
| General ledger | Reports → General ledger | `accountId`, `from`, `to` | landscape |
| Receivables ageing | Sales → Receivables ageing | `asOf` | landscape |
| Payables ageing | Purchases → Payables ageing | `asOf` | landscape |
| Profit by department or project | Reports → Profit by department | `type` (DEPARTMENT or PROJECT), `from`, `to`, optional `includeInactive` | landscape |

## API

`GET /v1/orgs/:orgId/reports/export/:report?format=csv|xlsx|pdf&<the report's parameters>`

* Needs `reports.read`; the ageing reports also need `sales.read` or `purchases.read`.
* Responds with the file as an attachment: `Content-Disposition` with a safe file name such
  as `trial-balance-2026-10-31.xlsx`, `Cache-Control: private, no-store`, `X-Content-Type-Options:
  nosniff` and `X-Report-SHA256`, the SHA-256 of the file.
* Refuses an unknown report (404 `NOT_FOUND`), a missing or unknown format (400
  `INVALID_FORMAT`), bad or unknown parameters (400 `VALIDATION_FAILED` with `details.issues`)
  and a start after the end (400 `INVALID_RANGE`). Another organisation's account or department
  is 404.
* Every export is written to the audit log as `report.exported` with the report, format,
  parameters, file name, size, row count and SHA-256, so a file handed to an auditor or bank can
  be matched to who exported it and when.

## The formats

One report model (`ExportReport` in `packages/accounting-engine/src/report-export.ts`: title,
organisation, period, currency, typed columns, rows with a style of normal, section, subtotal or
total, notes) is written out three ways. Amounts stay decimal strings until the last step.

**CSV** (`toCsv`): UTF-8 with a byte order mark so Excel reads non-English names, CRLF line ends,
RFC 4180 quoting. The title, organisation and period come first, then a blank line, the header
row and the table, then the notes. Amounts are plain decimals (`-1234.50`) that any program
parses. Text that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, tab or
carriage return), such as a customer called `=HYPERLINK(...)`, is prefixed with an apostrophe
(CSV injection).

**Excel** (`toXlsx`): one worksheet, written without dependencies as a stored ZIP of Office Open
XML. Amounts are numbers with a currency number format, so the totals can be summed and checked
in the spreadsheet; dates are Excel dates. The header row is frozen, numeric headers are right
aligned, subtotals and totals are bold with rules, notes and an export stamp sit underneath, and
the page is set to fit one page wide in the report's orientation. Text cells are inline strings,
never formulas.

Indian lakh and crore grouping (`12,34,56,789.00`) for INR: Excel and LibreOffice disagree on
conditional number formats for negative numbers, so instead of one conditional format each
amount cell picks a plain two-section format for its size band (below one lakh, below one crore,
below 100 crore, and so on up to 10 lakh crore). Checked by opening the files in LibreOffice and
reading the formatted text. Other currencies use thousands grouping.

**PDF** (`apps/api/src/report-exports/pdf.ts`, pdfkit): A4, landscape for wide reports. Title,
organisation, period and currency; a table whose column widths follow the column hints so it
always fits the page; the header row repeated on every page; long text cut with an ellipsis;
bold subtotals with a rule and totals with a double rule; the notes; and a footer on every page
with the organisation, report, period, export time and "Page n of N". The PDF's title, author
and creation date are set from the report.

## Web

`apps/web/src/components/reports/export-buttons.tsx` adds Export · CSV · Excel · PDF to each
report page header. It fetches the file first, so a refusal (a bad date range, no permission)
shows its reason under the buttons instead of downloading an error, then saves it with the
server's file name and shows "Downloaded <file>". The general ledger's buttons wait until an
account is chosen.

## Tests

* Engine (`packages/accounting-engine/test/report-export.test.ts`, 10): model checks, safe file
  names, formula neutralising, the CSV layout and quoting, CRC-32 and Excel date serials, the ZIP
  structure (signatures, sizes, CRCs), workbook content (numbers, dates, styles, frozen header,
  escaping, no formulas), lakh and crore band selection, and dropping characters XML cannot hold.
* API (`apps/api/test/report-exports.e2e.test.ts`, 8): CSV figures equal the JSON report,
  headers and hash, formula neutralising in CSV and text cells in Excel, lakh formats in Excel,
  PDF text (decompressed) with lakh grouping, page size and orientation, general ledger and
  profit by department, refusals, permissions and tenant isolation, and the audit entry.
* Browser (`apps/web/e2e/report-exports-flow.test.mjs`): downloads from the trial balance,
  receivables ageing, profit by department and general ledger pages, reads the files back, and
  sees a bad range refused on screen with nothing downloaded.

## Limitations

* PDFs use the PDF standard fonts (Helvetica), which hold Western European characters only;
  other characters (Devanagari, Arabic, CJK, the rupee sign) print as `?`. Amounts carry no
  currency symbol; the currency is printed in the header. Embedding a Unicode font is the fix.
* Exports are made on request; there are no scheduled or emailed exports yet (RPT-031, RPT-032).
* The Excel file has one sheet with values only, no formulas linking totals to rows.
* KPIs, management reports, budgets and cash-flow forecasts have their own screens and are not in
  this export yet.
