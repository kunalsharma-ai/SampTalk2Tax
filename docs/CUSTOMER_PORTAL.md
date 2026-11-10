# Customer portal (AR-030)

A customer can see their own account without signing in. Staff make a private link for them, and
the customer opens it to see:

- what they owe,
- their invoices and credit notes,
- the payments received from them,
- their statement.

They can also open or print any of their invoices. Where the business has made a payment link
for an invoice, they can pay it online. The portal is read-only and nothing in it changes the
books.

## Making and revoking links

On the customer's page (Sales → Customers → a customer), the **Customer portal** card has a
**Make portal link** button. It needs `sales.manage`.

- Choose how long the link works: 30, 90, 180 or 365 days, or until revoked.
- You can add a note for yourself, such as who the link was sent to.
- The full link is shown **once**. Copy it and send it to the customer.
- Talk2Tax stores only the SHA-256 of the secret, plus its first 8 characters so you can
  recognise the link in lists. The audit trail records the link by that prefix only.
- The card lists every link with who made it, its expiry, how often it was opened and when it was
  last opened, and its status (Active, Expired or Revoked).
- **Revoke** stops a link at once. A revoked link stays revoked.
- Links are never deleted. A database trigger enforces this, and it also prevents changing a
  link's customer, secret or expiry.

## What the customer sees

The page is at `/portal/<token>`.

- **From and for.** The business's legal name and GSTIN, and the customer's name and GSTIN.
- **Balance to pay, Overdue and Open invoices.** These are shown per currency. The balance is
  open invoices less unused credit notes and payments not yet matched to invoices.
- **Invoices.** Posted invoices and credit notes, newest first. You can show only those still to
  pay, or all of them. Each shows its amount, what is still to pay, its due date, days late and a
  status:
  - To pay, Part paid, Overdue, Paid or Cancelled for invoices;
  - Credit to use or Credit used for credit notes.

  A **Pay** button appears where the invoice has an open, unexpired payment link. It goes to the
  business's own gateway. Drafts never appear.
- **Opening an invoice.** It opens as a self-contained page printed with the business's invoice
  template. It is sandboxed, with no script and nothing loaded from the network.
- **Payments received.** The receipts recorded from the customer.
- **Statement.** Every invoice, credit note, payment and void in a chosen period, with the
  opening balance, a running balance and the closing balance. The default period starts on the
  first of the month a year ago. The statement can be printed. Invoices and credit notes in it
  can be opened; other rows cannot.

## Security

- **Tokens.** A token is `t2tp_` followed by 40 random letters and digits, about 238 bits.
- **Request checks.** Each request:
  1. checks the token's format;
  2. finds the link by its hash, which is the only cross-tenant lookup;
  3. refuses revoked or expired links, links of a suspended organisation, and links for an
     inactive customer;
  4. checks the organisation's data region;
  5. then narrows the request to that organisation. Row-level security keeps every later query
     inside that tenant, and every query also filters to that customer.
- **Rate limit.** Portal routes use the strict per-IP sign-in rate limit.
- **Web proxy.** The web app forwards `/api/portal/*` (GET only) to `/v1/portal/*` without any
  session cookie.
- **Response headers.** Responses send `Cache-Control: private, no-store` and
  `Referrer-Policy: no-referrer`. The page is marked noindex.
- **Link sharing.** Anyone who has the link can see the account, and the page says so. Revoke a
  link that reached the wrong person.

## API

| Method | Path | Access |
| --- | --- | --- |
| GET | `/v1/orgs/:orgId/contacts/:contactId/portal-links` | `sales.read` |
| POST | `/v1/orgs/:orgId/contacts/:contactId/portal-links` `{ expiresInDays: 30\|90\|180\|365\|null, note? }` | `sales.manage`; returns the token once |
| POST | `/v1/orgs/:orgId/contacts/:contactId/portal-links/:linkId/revoke` | `sales.manage` |
| GET | `/v1/portal/:token` | the link |
| GET | `/v1/portal/:token/statement?from&to&currency` | the link |
| GET | `/v1/portal/:token/documents/:documentId[?download=1]` | the link (HTML page) |

Errors: `PORTAL_LINK_INVALID` (404, with a message for the customer), `ALREADY_REVOKED`,
`CONTACT_INACTIVE`.

## Not built

- Customer accounts with sign-in, or one person seeing several customers.
- Sending the link by email from the app. Mail keys are still to come; for now, copy the link.
- Uploading remittance advice, raising disputes, or accepting quotes from the portal.
- Branding (logo and colours) or a custom domain for the portal.
