# Vendor portal (AP-013)

A vendor can see their account with the business, and send it invoices, without signing in.
Staff make a private link for them. The vendor opens it to see:

- what they are owed and how much of it is due now,
- their invoices as the business recorded them (bills and credits), with due dates, what is
  still to be paid, and any tax deducted at source,
- the payments made to them, with the bank reference,
- the purchase orders placed with them, with what is still to invoice,
- their statement.

They can also **send an invoice** with its PDF or a photo. A sent invoice waits for staff to
check it. Staff either record it against its bill, or turn it down with a reason the vendor
sees. Nothing a vendor does posts to the books. Bank details cannot be changed through the
portal; the page tells the vendor to contact the business instead.

## Making and revoking links

On the vendor's page (Purchases → Vendors → a vendor), the **Vendor portal** card has a **Make
portal link** button. It needs `purchases.manage`. Links work exactly like customer portal links
([CUSTOMER_PORTAL.md](CUSTOMER_PORTAL.md)), with these differences:

- The token is `t2tv_` followed by 40 random letters and digits. A customer token (`t2tp_`)
  never opens the vendor portal, and the reverse.
- The secret is shown once. Talk2Tax stores only its SHA-256 and its first 8 characters.
- Links last 30, 90, 180 or 365 days, or until revoked. A revoked link stays revoked and links
  are never deleted (a database trigger enforces both).
- The card also counts the invoices this vendor has sent, and links to them.

## What the vendor sees

The page is at `/vendor-portal/<token>`.

- **Owed to you, Due now and Open invoices**, per currency. "Owed to you" is open bills less
  unused vendor credits and payments not yet matched to bills. "Due now" is open bills due on or
  before today.
- **Your invoices as recorded.** Posted bills and vendor credits, newest first, by the vendor's
  own invoice number (the bill's reference). A bill's status is To be paid, Due, Part paid, Paid
  or Cancelled. A credit's status is Credit to use or Credit used. Drafts never appear.
- **Payments made to you.** Payments recorded to the vendor, with the bank reference.
- **Purchase orders.** Orders issued to the vendor (not drafts or cancelled ones), with the total
  and what is still to invoice.
- **Statement.** Every bill, credit, payment and void in a chosen period, with opening, running
  and closing balances. It can be printed.

## Sending an invoice

The vendor enters their invoice number, the invoice date, the total with tax, and optionally a
purchase order, a note and a file.

The portal refuses an invoice when:

- the invoice number is empty, over 40 characters, or has characters other than letters,
  digits, spaces and `- / _ .`;
- the date is in the future, or more than 18 months ago;
- the total is not more than zero, or has more than 2 decimal places;
- the purchase order is not one of the vendor's issued or closed orders;
- the same invoice number is already waiting or already recorded. Case, spaces and the
  separators `- / _ .` do not matter, so `SC/2240` and `sc 2240` are the same number. A bill of
  that vendor with that number as its reference counts as recorded;
- 25 of the vendor's invoices are already waiting to be checked.

**The file.** It is sent right after the invoice. It must be a PDF, PNG, JPEG or WebP file of at
most 5 MB. Its type is read from its first bytes, not from the name. It can be added once, within
an hour of sending, while the invoice is still waiting. It counts toward the plan's monthly
uploads.

The vendor sees each invoice they sent with its status:

- **Received, being checked**,
- **Recorded**, with the bill number once the bill is posted,
- **Not accepted**, with the reason.

An invoice that was turned down can be sent again.

## Checking sent invoices

**Purchases → Vendor invoices** lists them, newest first, filtered by status (To check,
Recorded, Turned down, All). From a vendor's card, it shows that vendor only. Each row shows the
file (it opens in a sandboxed tab), the note and the quoted purchase order.

- **Record.** Choose the bill that records the invoice. The list offers the vendor's draft and
  posted bills that do not already record a sent invoice. A bill whose reference is the same
  invoice number comes first and is chosen for you. The dialog warns when the amounts differ. The
  vendor's file is attached to the bill, unless the same file is already there. A bill records
  at most one sent invoice. Record the bill first, as usual, if there is none.
- **Turn down.** Give a reason of at least 3 characters. The vendor sees it.

Both need `purchases.manage`. A sent invoice is decided once. What the vendor sent never changes
and is never deleted; a database trigger enforces this.

## Audit

- `vendor_portal.link_created` and `vendor_portal.link_revoked` name the link by its prefix only.
- `vendor_portal.invoice_sent` and `vendor_portal.file_sent` have no user as actor. They record
  the link prefix, the invoice number and the file's SHA-256 and size.
- `vendor_portal.invoice_recorded` records the bill, the attachment, and whether the bill's
  reference matched. `vendor_portal.invoice_rejected` records the reason.

## Security

These are the same as the customer portal: format check, a hash lookup as the only cross-tenant
step, refusal of revoked or expired links, suspended organisations and inactive contacts, a data
region check, then row-level security narrowed to the organisation. Every query is also filtered
to the vendor.

- **Rate limit.** Every portal route uses the per-IP sign-in rate limit.
- **Responses.** They send `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`,
  and the page is noindex.
- **Web proxy.** The web proxy `/api/vendor-portal/*` never forwards a session cookie. It allows:
  - GET of the overview and the statement;
  - POST of JSON to `invoices` only (at most 10 KB);
  - PUT of a file to `invoices/<id>/file` only (PDF, image types or octet-stream, at most 5 MB).

## API

| Method | Path | Access |
| --- | --- | --- |
| GET | `/v1/orgs/:orgId/contacts/:contactId/vendor-portal-links` | `purchases.read` |
| POST | `/v1/orgs/:orgId/contacts/:contactId/vendor-portal-links` `{ expiresInDays, note? }` | `purchases.manage`; returns the token once |
| POST | `/v1/orgs/:orgId/contacts/:contactId/vendor-portal-links/:linkId/revoke` | `purchases.manage` |
| GET | `/v1/orgs/:orgId/purchases/vendor-invoices?status&contactId` | `purchases.read` |
| GET | `/v1/orgs/:orgId/purchases/vendor-invoices/:id/file[?inline=1]` | `purchases.read` |
| GET | `/v1/orgs/:orgId/purchases/vendor-invoices/:id/bills` | `purchases.read` |
| POST | `/v1/orgs/:orgId/purchases/vendor-invoices/:id/record` `{ documentId }` | `purchases.manage` |
| POST | `/v1/orgs/:orgId/purchases/vendor-invoices/:id/reject` `{ reason }` | `purchases.manage` |
| GET | `/v1/vendor-portal/:token` | the link |
| GET | `/v1/vendor-portal/:token/statement?from&to&currency` | the link |
| POST | `/v1/vendor-portal/:token/invoices` `{ invoiceNumber, invoiceDate, amount, currency, purchaseOrderId?, note? }` | the link |
| PUT | `/v1/vendor-portal/:token/invoices/:id/file?fileName=` (raw file body) | the link |

Errors:

- `PORTAL_LINK_INVALID` (404)
- `SUBMISSION_INVALID` (422, with `details.issues`)
- `ALREADY_SENT`, `TOO_MANY_WAITING`, `FILE_ALREADY_SENT`, `FILE_WINDOW_CLOSED`, `ALREADY_DECIDED`,
  `BILL_TAKEN`, `BILL_VOID` (409)
- `WRONG_VENDOR` (422)
- `UNSUPPORTED_FILE` (415)
- `FILE_TOO_LARGE` (413)

## Not built

- Vendor accounts with sign-in, or one person seeing several vendors.
- Sending the link by email from the app. Mail keys are still to come; for now, copy the link.
- Making a bill from a sent invoice automatically, or reading the PDF. Reading needs the AI keys
  and is not faked.
- Vendors changing their bank details, GSTIN or address through the portal. This is
  deliberately left out because bank changes are a fraud risk; see Vendor risk.
- Vendors acknowledging purchase orders or posting delivery notes.
