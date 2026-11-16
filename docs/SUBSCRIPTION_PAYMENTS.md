# Paying for a subscription online

M9 slice 3. Organisations pay for their Talk2Tax plan online. Payments go through Razorpay (for India) or Stripe (for other countries). Each payment produces a tax invoice. Renewals and reminders run on their own. This is Talk2Tax's own billing and never touches an organisation's books (SUBS-032).

## Setting it up (Platform admin → Payments)

A super admin sets everything up in the app. Nothing is set in server environment variables.

- **Seller details**: the legal name, address, country, GSTIN (optional; its first two digits give the state), billing email, GST rate (default 18%), SAC code (default 998314) and invoice number prefix (default `T2T`). Invoices cannot be issued until these are saved.
- **Gateways**: Razorpay and Stripe. For each gateway, enter:
  - test or live mode;
  - the currencies it takes (INR, USD); each currency is paid through exactly one enabled gateway;
  - the keys: for Razorpay, the key id and key secret; for Stripe, the secret key. Keys are checked against the mode: `rzp_test_`/`rzp_live_`, `sk_test_`/`sk_live_` (or `rk_` for a restricted key);
  - the webhook secret.

  Secrets are sealed with AES-256-GCM using the same key as organisation integrations (`INTEGRATIONS_ENCRYPTION_KEY`, or one derived from `JWT_SECRET`). They are never returned; only their last four characters are shown. **Test connection** calls the gateway with the stored key (Stripe `GET /v1/balance`, Razorpay `GET /v1/payments`) and records the answer.
- **Webhook address** to enter at the gateway: `APP_URL/api/webhooks/payments/razorpay` or `…/stripe`. The page shows it, with the events to choose:
  - Razorpay: `payment_link.paid`;
  - Stripe: `checkout.session.completed` and `checkout.session.async_payment_succeeded`.

  The web app passes the exact bytes and the signature headers to `POST /v1/billing/webhooks/:provider`.

## What paying buys

`checkoutPlan` in `packages/accounting-engine/src/subscription-billing.ts` decides what a payment buys:

| Situation | Kind | Charged | Period |
|---|---|---|---|
| Trial, or after a trial, a lapse or a cancellation | NEW | plan price | from the end of a running trial (no trial days lost), otherwise from now |
| Paid period (grace included), same plan and billing | RENEWAL | plan price | straight after the current period |
| Paid period, dearer plan, same billing | UPGRADE | the difference for the days left | ends with the current period |
| Paid period, cheaper plan or other billing | scheduled | nothing now | the renewal invoice is for the new plan |

Plan prices exclude tax. **GST** is charged only when the supplier is in India and has a GSTIN:

- customer in the supplier's state, or with no state on record (the place of supply is then the supplier's location): CGST and SGST at half the rate each;
- customer in another state: IGST;
- customer outside India: no GST, because this is an export of services, zero-rated under a bond or letter of undertaking. The invoice prints that endorsement.

A supplier outside India, or one not registered for GST, charges no tax, and the invoice says so. A customer's GSTIN and state come from its GST registration in Talk2Tax.

## The flow

1. An owner or admin chooses a plan on **Settings → Subscription**. The page shows the period, the subtotal, each tax line and the total (`GET …/subscription/quote`).
2. **Pay now** (`POST …/subscription/checkout`):
   - issues an unpaid invoice, called a payment request (reference `PR-XXXXXXXX`);
   - voids any earlier unpaid one and ends its checkout at the gateway;
   - creates a Stripe Checkout Session (open for 23 hours) or a Razorpay Payment Link (open for 7 days);
   - sends the customer to the gateway's page. Card and UPI details never reach Talk2Tax.
3. The payment counts only when the gateway confirms it, in one of two ways:
   - a signed webhook. Stripe is verified with an HMAC-SHA256 of `t.body` and refused if more than 5 minutes old. Razorpay is verified with an HMAC-SHA256 of the body. Each notice is handled once, by its event id, and every notice is logged, including refused ones.
   - asking the gateway (`POST …/invoices/:id/check`). The page does this when the customer comes back, so a late webhook does not leave them waiting.
4. `markPaid` then runs once, under a row lock:
   - it checks that the amount and currency match. A mismatch, or a payment on a replaced invoice, is recorded and not applied;
   - it gives the tax invoice number, `PREFIX/YY-YY/NNNNN`: one series per Indian financial year, at most 16 characters, consecutive;
   - it moves the subscription on.

   Paid and void invoices cannot be changed or deleted (a database trigger enforces this).
5. The invoice page is printable or can be saved as a PDF. It shows the seller and buyer, both GSTINs, the place of supply, the SAC code, the tax lines and the payment reference.

## Renewals and reminders

The renewal runner checks every `BILLING_RUNNER_INTERVAL_SECONDS` (default 3600; 0 turns it off). Staff can also start it with **Issue due renewals now** on Platform admin → Invoices.

- **Renewal invoices**: a renewal invoice is issued 7 days before the paid period ends. It uses the scheduled plan if there is one and the organisation's members fit it. Cancelled subscriptions do not renew.
- **Reminders**: each reminder is sent once per invoice. The stages are:
  - upcoming: the last 7 days of the period;
  - due: grace has started;
  - final: 2 days before grace ends;
  - lapsed: the books are now read-only.

  Reminders are emailed to the owners and admins through the organisation's email set-up (Settings → Integrations, or the server's fallback). Each reminder is recorded in the subscription history, with whether it was emailed.
- **Late payment**: a renewal paid after grace has ended starts from the day it is paid, so read-only days are not charged.

## Platform admin → Invoices

This page lists every invoice. Staff can:
- record a payment received by bank transfer or cheque, with its reference;
- void an unpaid invoice, with a reason;
- ask the gateway about a payment;
- see the latest gateway notices and their outcomes.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BILLING_RUNNER_INTERVAL_SECONDS` | 3600 | How often renewals and reminders are checked |
| `PAYMENTS_TIMEOUT_SECONDS` | 20 | How long to wait for a gateway |
| `PAYMENTS_STRIPE_API_URL`, `PAYMENTS_RAZORPAY_API_URL` | the real APIs | Point at the local stand-in in tests and previews only |

## Tests

- Engine: `test/subscription-billing.test.ts`, 11 tests covering checkout kinds, GST, invoice numbers, minor units and reminder stages.
- API: `test/subscription-payments.e2e.test.ts`, 9 tests. They run the real gateway code against `test-support/payments-stand-in.mjs`, a local imitation of the Stripe and Razorpay endpoints that serves a test payment page and sends correctly signed webhooks. They cover:
  - set-up and key sealing;
  - a Razorpay payment with GST confirmed by webhook;
  - an upgrade and a scheduled downgrade;
  - a forged signature;
  - a Stripe export confirmed by asking the gateway;
  - duplicate and stale webhooks;
  - a wrong amount;
  - renewals, reminders and a manual payment;
  - paying an open renewal online.
- Browser: `e2e/subscription-payments-flow.test.mjs`. An admin sets up the seller details and Razorpay in the UI. An owner pays on the stand-in page, the webhook comes back through the web app, and the owner sees the tax invoice.

## Not yet

- Checked against real Razorpay and Stripe test accounts (INTG-007, INTG-009 are marked Integration pending).
- Automatic charging of saved cards, UPI AutoPay or e-mandates. Renewals are paid by the customer.
- Refunds and credit notes. A payment on a replaced invoice is flagged for staff to refund at the gateway.
- Coupons, add-ons and usage-based charges.
- Tax for suppliers outside India (VAT, sales tax).
