# Payment links (AR-018)

A payment link lets a customer pay an invoice online, by card, UPI, net banking or wallet, through
the organisation's **own** Razorpay or Stripe account. Money goes straight from the customer to the
organisation's gateway account; Talk2Tax never holds it.

This is separate from Talk2Tax's own subscription billing (Platform admin → Payments), which uses
the platform's gateway. Both use the same Stripe and Razorpay client code
(`apps/api/src/billing/payments/gateways.ts`).

## Setting up a gateway

**Settings → Payment gateways** (owners and admins, permission `org.manage`):

* Razorpay: key id (`rzp_test_…` or `rzp_live_…`), key secret and webhook secret.
* Stripe: secret key (`sk_test_…`/`sk_live_…`, or a restricted `rk_…` key) and webhook signing
  secret (`whsec_…`).
* **Mode**: test or live. The key must match the mode, and switching mode needs the key again.
* **Takes payments in**: INR and/or USD. Each currency goes through one gateway.
* **Paid out to**: the bank account the gateway settles into. Receipts from links are recorded here.

Keys are sealed with the server's secret box before they are stored (`org_payment_gateways`),
shown only as their last four characters, and never written to the audit trail (only that they
changed). **Test connection** makes one read-only call to the gateway with the keys.

Enter the **webhook address** shown on the card at the gateway:
`<APP_URL>/api/webhooks/collect/<organisation id>/razorpay` (event `payment_link.paid`) or
`…/stripe` (events `checkout.session.completed`, `checkout.session.async_payment_succeeded`). The
web app passes the exact bytes and signature headers to the API, which checks them with that
organisation's webhook secret. The last ten notices, with whether the signature was valid and what
was done, are listed on the page.

A gateway with open links cannot be removed; cancel the links first.

## Making a link

On a **posted invoice** in INR or USD, the **Payment links** card has **Make payment link**: for all
that is still owed, or a smaller amount. Razorpay makes a payment link (valid 7 days); Stripe a
Checkout session (valid 23 hours). Links are numbered `PL-0001` per organisation. One link can be
open per invoice at a time; an expired one is closed when a new one is made.

**Copy link** puts the gateway's address on the clipboard to send to the customer. After paying, the
customer lands on `/paid?ref=PL-0001`, a public thank-you page that shows nothing from the books.

## When it is paid

A link is settled when either:

* the gateway's **signed notice** arrives (duplicates by event id are ignored), or
* someone presses **Check payment** (or **Cancel**, which checks first), which asks the gateway.

Settling records an **ordinary receipt** for the amount the gateway reports, dated today, into the
gateway's deposit account, referenced with the gateway's payment id, and applies it to the invoice
up to what is still owed (anything more stays on account as the customer's credit). It runs once,
under a row lock. The link records the paid amount, payment id, receipt and how it was settled.

If the receipt cannot be recorded, for example because today's period is locked or a USD receipt
has no exchange rate for today, the link stays open, the notice records why, and **Check payment**
settles it once the cause is fixed.

## Guards in the database

`t2t_check_payment_link` (migration `20261206090000_payment_links`): links are never deleted; a
paid, cancelled or expired link is final; a link keeps its invoice, gateway, checkout and amount.
A partial unique index allows one open link per invoice; `(provider, gateway_ref)` and the receipt
are unique. All three tables have row-level security by organisation.

## API

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/orgs/:orgId/settings/payment-gateways` | org.manage |
| PUT, DELETE | `/v1/orgs/:orgId/settings/payment-gateways/:provider` | org.manage |
| POST | `/v1/orgs/:orgId/settings/payment-gateways/:provider/test` | org.manage |
| GET | `/v1/orgs/:orgId/sales/payment-links?status=&documentId=` | sales.read |
| POST | `/v1/orgs/:orgId/sales/documents/:documentId/payment-links` `{ amount? }` | sales.manage |
| POST | `/v1/orgs/:orgId/sales/payment-links/:id/check` | sales.manage |
| POST | `/v1/orgs/:orgId/sales/payment-links/:id/cancel` | sales.manage |
| POST | `/v1/payment-links/webhooks/:orgId/:provider` | public, signed |

## Tests

* Engine: `packages/accounting-engine/test/payment-links.test.ts`.
* API: `apps/api/test/payment-links.e2e.test.ts` against the local gateway stand-in
  (`test-support/payments-stand-in.mjs`): setup and sealing, a link paid by Razorpay's notice, part
  payment settled by checking, cancelling, Stripe in USD (with and without the day's rate),
  forged notices, tenant isolation and the database guards.
* Browser: `apps/web/e2e/payment-links-flow.test.mjs`: setup in the app, a link on an invoice, the
  customer paying on the gateway's page, the thank-you page, and the invoice settled.

Not built yet: emailing the link to the customer from Talk2Tax (copy it into your own email for now),
partial refunds through the gateway, and currencies other than INR and USD.
