# Invoice templates and e-signatures

How invoices and credit notes look when they are printed, saved as PDF or downloaded, and how a
member e-signs a posted invoice. Built in M6 (slice 5).

## What a user can do

* **Start from a country preset.** Eight presets set the title, the tax number label, the tax
  name, the columns shown, the date and number style, the paper size and the country checks:

  | Preset | Title | Tax number | Checks the designer warns about |
  |---|---|---|---|
  | India: GST tax invoice | Tax Invoice | GSTIN | CGST Rule 46: "Tax Invoice" title, invoice details (number, date, place of supply), recipient, HSN/SAC column, tax by head (CGST/SGST/IGST), signature |
  | UAE: VAT tax invoice | Tax Invoice \| فاتورة ضريبية | TRN | "Tax Invoice" title, VAT rate and VAT amount columns, invoice details |
  | United Kingdom: VAT invoice | VAT Invoice | VAT No. | VAT rate column, totals |
  | United States: invoice | Invoice (US Letter, month-first dates) | EIN | none |
  | Singapore: GST tax invoice | Tax Invoice | GST Reg No. | "Tax Invoice" title, totals |
  | Australia: tax invoice | Tax invoice | ABN | "tax invoice" in the title |
  | European Union: VAT invoice | Invoice (ISO dates) | VAT ID | customer details, VAT rate column, VAT by rate |
  | Generic | Invoice | Tax ID | none |

  The checks are warnings: the template still saves. They summarise the rules; they are not legal
  advice and have not been reviewed by a tax professional in each country.
* **Pick a theme**: Classic, Modern (colour band), Minimal, Bold (accent bar and coloured total)
  or Elegant (centred, small capitals, double rules).
* **Pick a palette** (Indigo, Emerald, Crimson, Ocean, Saffron, Plum, Slate, Black and white) or
  set each of the seven colours with a colour picker or a hex code. The designer warns when text
  is hard to read on the background (contrast below 4.5 to 1).
* **Edit every section.** Header, title, invoice details, bill to, line items, totals, tax
  summary, amount in words, bank details, notes, terms, signature and footer can each be shown or
  hidden, moved up or down, given a heading, given text (with placeholders such as
  `{{doc.dueDate}}`), set to full or half width (two half sections sit side by side) and aligned.
  The line items table's columns can be shown, hidden, renamed and reordered. Section text is
  plain text: anything that looks like HTML is printed as typed.
* **Add a logo** (PNG, JPEG or WebP up to 500 KB; SVG is refused because it can carry script).
* **Write an HTML template** instead of using the designer. The HTML is the page body with a
  `<style>` block; values come from placeholders (`{{doc.number}}`, `{{#lines}}…{{/lines}}`,
  `{{#signature}}…{{/signature}}`). Each new HTML template starts from a working example, and the
  editor lists every placeholder (click to insert) and checks the code as you type.
* **Preview** with a sample invoice or any real invoice while designing.
* **Choose per invoice.** Invoices print with the organisation's default template. The print page
  can show any template, and "Always print this invoice with it" stores the choice on the
  invoice. This works after posting: the template is the only thing about a posted document that
  can change.
* **Print or save as PDF** from the print page (the browser's print dialog), or download the
  invoice as one self-contained HTML file.
* **E-sign.** Each member with `documents.sign` saves a signature (drawn on a pad, typed in a
  handwriting style, or uploaded) with the name and designation to print under it. On a posted
  invoice or credit note, "Sign" places a copy of that signature on the document and records a
  SHA-256 hash of what was signed. The signature can be withdrawn with a reason by the signer or an
  owner/admin; withdrawn signatures stay in the history.

## Placeholders

| Placeholder | Value |
|---|---|
| `title`, `labels.taxId`, `labels.tax` | The template's title and labels |
| `logo` | The logo as a `data:` URL (empty when none), for `<img src="{{logo}}">` |
| `doc.kind`, `doc.number`, `doc.issueDate`, `doc.dueDate`, `doc.reference`, `doc.memo`, `doc.currency`, `doc.status` | The document; dates formatted in the template's style |
| `doc.isDraft`, `doc.isVoid` | For `{{#doc.isDraft}}DRAFT{{/doc.isDraft}}` |
| `doc.placeOfSupply`, `doc.reverseCharge`, `doc.irn`, `doc.ackNo`, `doc.ackDate` | India GST and e-invoice details |
| `seller.name`, `seller.legalName`, `seller.taxId` | The organisation (GSTIN from the GST registration) |
| `buyer.name`, `buyer.taxId`, `buyer.address`, `buyer.email`, `buyer.phone`, `buyer.state` | The customer |
| `{{#lines}}` … `no`, `description`, `hsn`, `quantity`, `unitPrice`, `taxRate`, `taxAmount`, `amount`, `total` | One block per line |
| `{{#taxes}}` … `rate`, `taxable`, `cgst`, `sgst`, `igst`, `amount`; `hasGst` | Tax by rate |
| `totals.subtotal`, `totals.tax`, `totals.withholding`, `totals.total`, `totals.paid`, `totals.due` | Totals, formatted |
| `amountInWords` | "Rupees One Lakh … Only" (lakh and crore for INR; thousands and millions otherwise) |
| `{{#signature}}` … `image`, `name`, `designation`, `signedAt`, `hash` | Present once signed |

Placeholders that are not in this list print empty; the editor and the API name them as warnings.

## Safety of HTML templates

User HTML is treated as untrusted:

1. **Checked when saved** (engine `checkHtmlTemplate`, run by the API and live in the editor):
   no `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>` or inputs, `<base>`, `<link>`,
   `<meta>`, `<html>/<head>/<body>`, `<foreignObject>`, media tags; no `on…=` event handlers; no
   `javascript:`/`vbscript:` URLs; nothing loaded from the network (`src=http…`, `url(http…)`,
   `@import`); no CSS `expression()`; at most 200 KB; placeholders must parse.
2. **Values are always escaped.** There is no unescaped placeholder (`{{{…}}}` and `{{&…}}` are
   refused).
3. **The page allows nothing.** Every rendered page carries
   `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:`.
   The HTML download adds `sandbox` to that header.
4. **The app shows it in a sandboxed frame** with no `allow-scripts`, so even markup that slipped
   past the checks could not run code.

## How the e-signature works

* A signature is an image the member made (drawn, typed or uploaded), stored per member and
  organisation. One is in use at a time; replacing or removing it revokes the old one. Signature
  images are never edited (database trigger).
* Signing is allowed only on posted invoices and credit notes, only with the signer's own
  signature in use, and once at a time per document (partial unique index and trigger).
* The signed document keeps its own copy of the image, the signer's name and designation, the
  time, the browser and a SHA-256 of the invoice's canonical content: organisation, document id,
  kind, number, dates, currency, customer name and tax number, each line (description, quantity,
  price, rate, net, tax) and the totals (engine `canonicalInvoiceContent`).
* On every view the hash is worked out again. **Valid**: the invoice is unchanged. **Changed**:
  it no longer matches (posted documents cannot be changed through the app, so this means a change
  outside it). **Voided**: the invoice was voided after signing.
* Signing, withdrawing, saving and removing signatures are written to the audit trail with the
  hashes.

**What this is not.** This is an electronic signature with tamper evidence, suitable for the
"signature of the supplier" on a printed invoice. It is not Aadhaar eSign or a digital signature
certificate (DSC/PKI). Those need a licensed eSign service provider or a certificate on a token,
and are listed as not connected. The PDF made by the browser's print dialog does not carry a
cryptographic signature.

## API

| Route | Permission | |
|---|---|---|
| `GET /v1/orgs/:orgId/invoice-templates[?archived=1]`; `GET …/:id` | sales.read | Templates; one with its layout, HTML, logo and warnings |
| `POST …/invoice-templates` `{name, presetId, engine?, theme?, paletteId?}` | templates.manage | New from a preset; the first becomes the default |
| `PUT …/:id` `{name, engine, layout, html?}` | templates.manage | Save the design (checked by the engine) |
| `POST …/:id/duplicate`, `POST …/:id/default`, `POST …/:id/archive {archived}` | templates.manage | Copy, make default, archive or restore |
| `PUT …/:id/logo {imageBase64}`, `DELETE …/:id/logo` | templates.manage | Logo |
| `GET /v1/orgs/:orgId/invoice-print/:documentId[?templateId=]` | sales.read | The invoice's data, the template it prints with, the templates to choose from, its signature and check |
| `GET …/invoice-print/:documentId/html[?templateId=&download=1]` | sales.read | The rendered page |
| `PUT …/invoice-print/:documentId/template {templateId \| null}` | sales.manage | Print this invoice with a template |
| `POST …/invoice-print/:documentId/signature` | documents.sign | Sign with your signature |
| `POST …/invoice-print/:documentId/signature/withdraw {reason}` | documents.sign | Withdraw (signer, owner or admin) |
| `GET`, `PUT {kind, signerName, designation?, imageBase64}`, `DELETE /v1/orgs/:orgId/signatures/me` | documents.sign | Your signature |

Errors: `TEMPLATE_INVALID` (with every problem in `details.issues` for HTML), `TEMPLATE_NAME_TAKEN`,
`TEMPLATE_ARCHIVED`, `TEMPLATE_IS_DEFAULT`, `TEMPLATE_IN_USE`, `IMAGE_INVALID`, `IMAGE_TOO_LARGE`
(413), `DOCUMENT_NOT_POSTED`, `DOCUMENT_VOID`, `ALREADY_SIGNED`, `NO_SIGNATURE`, `NOT_SIGNED`,
`NOT_YOUR_SIGNATURE`.

## Database

`invoice_templates`, `user_signatures`, `document_signatures` and `documents.template_id`; see
[`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md). Migration `20261103110000_invoice_templates`.

## Screens

* Sales → **Invoice templates**: the list, and a new template from a preset with theme and palette
  cards and a live preview.
* **Designer** (`/settings/invoice-templates/:id`): theme and colours, sections and columns,
  labels and formats, logo, HTML editor with placeholder reference; live preview with a sample or
  a real invoice; country warnings.
* Invoice → **Print, PDF and sign** (`/print/:documentId`): the rendered invoice, template choice,
  print or save as PDF, HTML download, sign, verify, withdraw.
* Sales → **My signature**: draw, type or upload.

## Not built yet

Templates for quotes, statements, receipts, purchase orders and payslips; emailing an invoice as a
PDF attachment (the automation email sends text only); a server-made PDF file (planned with report
exports, RPT-033); Aadhaar eSign or DSC through a provider; QR codes (the India e-invoice signed QR
is shown as the IRN text only, and UPI payment QR is not drawn); right-to-left body text for
Arabic; custom fonts (system fonts only, since pages load nothing from the network); a visual
drag-and-drop canvas (sections move with up and down buttons).
