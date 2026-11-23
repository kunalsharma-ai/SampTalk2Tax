# Reverse charge (TAX-032)

Under reverse charge the buyer, not the supplier, pays the GST. This applies to notified goods and
services (CGST Act s.9(3)) and to services imported from abroad (IGST Act s.5(3)). Talk2Tax already
records a bill or vendor credit under reverse charge: tick **Reverse charge** on the bill. The tax is
posted as an output liability and an input credit, and it flows into GSTR-3B and the GST payment,
where it is paid in cash (s.49(4)).

**Tax → Reverse charge** adds three things.

## The month's register

The register lists posted bills and vendor credits under reverse charge that are dated in the chosen
month. For each one it shows:

- the taxable value and the tax by head (IGST, CGST, SGST);
- the notified category its HSN/SAC falls under;
- whether a self-invoice is needed.

Vendor credits reduce the totals. The total is the tax to pay in cash for the month. If a GST payment
has been recorded for the month, the register shows it.

## Bills that may need reverse charge

These are posted bills **not** recorded under reverse charge whose HSN/SAC falls under a notified
category. Examples are security services (9985 2x), legal services by an advocate (99821), a goods
transport agency (9965) and metal scrap (7204 and others).

- Categories that apply only to unregistered suppliers are not raised when the supplier has a GSTIN.
  These are commercial rent and metal scrap.
- Every category has conditions the books cannot see, such as whether the supplier is a body corporate
  or whether a goods transport agency opted to charge GST itself. So a match is a prompt to check,
  never a correction.

The table of categories is in `packages/tax-engine/src/india/reverse-charge.ts`. Each entry names its
notification entry: Notification 13/2017-Central Tax (Rate) for services, and Notification
4/2017-Central Tax (Rate) for goods, as amended.

## Self-invoices

When the supplier is not registered (no GSTIN, or outside India), the buyer issues the tax invoice
itself (s.31(3)(f)).

- It is due within 30 days of receiving the supply (rule 47A). The bill date is taken as the date the
  supply was received.
- The register marks each bill **To issue** or **Overdue**.
- Issuing a self-invoice gives it a number in its own series for the financial year, such as
  `RCM/2026-27/0001`.
- One self-invoice is issued per bill. It can never be changed or deleted, and it is kept in
  `rcm_self_invoices`.
- The self-invoice page shows the recipient, the supplier, the place of supply, the HSN/SAC lines and
  the tax by head, and is marked "tax payable on reverse charge: yes".

## API

| Call | Permission | What it does |
| --- | --- | --- |
| `GET /v1/orgs/:orgId/gst/reverse-charge?period=YYYY-MM` | `reports.read` | The register, the self-invoice counts, bills that may need reverse charge, the month's GST payment and the category table. |
| `GET /v1/orgs/:orgId/gst/reverse-charge/:documentId/self-invoice` | `reports.read` | The self-invoice for a bill, issued or as a draft. |
| `POST /v1/orgs/:orgId/gst/reverse-charge/:documentId/self-invoice` with `{ issuedOn? }` | `accounts.manage` | Issues the self-invoice. Returns 422 with the issues when it cannot be issued: a vendor credit, a registered supplier, already issued, dated before the bill or in the future, or a void bill. Audited as `gst.rcm_self_invoice_issued`. |

All three calls need a GST registration (409 `GST_NOT_REGISTERED` otherwise).

## Not built

- The payment voucher under s.31(3)(g).
- Reverse charge on documents in a foreign currency.
- Promoters under s.9(4).
- Government and director services, which have no specific SAC.
- Suggesting reverse charge while the bill is being entered. It is checked after posting.
