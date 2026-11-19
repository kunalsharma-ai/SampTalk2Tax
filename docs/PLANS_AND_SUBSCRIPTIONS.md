# Plans and subscriptions

This is the second slice of M9. It covers Talk2Tax's own plans and each organisation's
subscription. This is the bill for Talk2Tax itself. It is kept apart from every organisation's
books (SUBS-032): subscriptions live in their own tables and never post a journal.

## Plans

Platform administrators edit plans under **Platform administration → Plans**. Each plan has:

* **Prices.** Every plan is priced in INR for organisations in India and USD for organisations
  elsewhere, with a monthly price and an annual price.
* **Limits.**
  * Members.
  * AI requests a month. The usage slice will count and enforce these.
  * Uploads a month. Also counted and enforced by the usage slice.

  A limit left empty means no limit.
* **Modules:**
  * AI: the copilot and the agents for collections and bank reconciliation suggestions.
  * Payroll.
  * Foreign currencies (exchange rates and revaluation).
  * Group consolidation (with intercompany).
* **Offered or not.** A plan that is not offered cannot be requested, but organisations already
  on it stay on it.

The four starting plans use the directive's **proposed launch prices**. These are not final,
validated commercial rates (SUBS-010). Annual billing costs ten months.

| Plan | India (a month) | Elsewhere (a month) | Members | Modules |
|---|---|---|---|---|
| Starter | ₹499 | $9 | 2 | Core books, invoicing, banking, tax, reports |
| Growth | ₹1,499 | $25 | 5 | + AI |
| Professional | ₹3,499 | $59 | 15 | + Payroll, foreign currencies |
| Enterprise | ₹8,999 | $149 | No limit | + Group consolidation |

Each plan is checked before it is saved:

* The code is 2 to 24 capital letters, digits or underscores.
* Prices are above zero and have at most 2 decimals.
* Limits are whole numbers of 1 or more, or empty for no limit.
* Only known modules can be listed.

Every change is audited (`platform.plan_created`, `platform.plan_changed`), with the plan
before and after.

## A subscription per organisation

* **Trial.** A new organisation starts a trial of **every module** (the Enterprise plan) for
  `PLAN_TRIAL_DAYS`, which is 14 days unless set otherwise.
* **Demo organisations** are **complimentary**: no charge and no end date.
* **Organisations created before this release** were given a 14-day trial by the migration.
  Demo organisations among them became complimentary.
* **Billing currency.** It is set when the organisation is created: INR in India, USD
  elsewhere.

What the organisation can do depends on the subscription's status and dates:

| State | Books |
|---|---|
| Trial, before it ends | Full use |
| Paid, before its period ends | Full use |
| Paid, up to 7 days after its period ends (grace) | Full use, with a "payment is due" banner |
| Cancelled, before its period ends | Full use, with a banner |
| Complimentary | Full use |
| Trial ended / lapsed after grace / cancelled after its period | **Read only** |

**Read only** means every record can still be opened, reported and exported. Any change is
refused with `402 PLAN_REQUIRED`. Choosing a plan still works in this state.

## Enforcement

* **Modules.** A request that changes something in a module the plan does not include is
  refused with `403 FEATURE_NOT_IN_PLAN`. The modules are AI, Payroll, Foreign currencies and
  Consolidation. Reading is never refused, so past payroll runs, revaluations and AI activity
  stay visible after a downgrade. In the navigation, these modules are marked **Upgrade**.
* **Members.** Adding a member, creating an invitation and accepting an invitation are all
  refused with `409 PLAN_LIMIT` at the plan's limit. Open invitations count towards the limit.
* **Smaller plans.** A smaller plan cannot be requested or activated while the organisation has
  more members than that plan allows.

## Choosing and activating a plan

Owners and admins open **Settings → Subscription**. It shows:

* the current plan, its status and its dates;
* member usage;
* every plan offered, priced in the organisation's currency, monthly or annual;
* the subscription's history.

From there they **request** a plan, and can withdraw the request.

When a payment gateway takes the organisation's currency, choosing a plan shows the price with
tax and a **Pay now** button; see [`SUBSCRIPTION_PAYMENTS.md`](SUBSCRIPTION_PAYMENTS.md). Without
one, the plan is requested and Talk2Tax activates it when payment is received.

Platform administrators open **Platform administration → Subscriptions**, where they can:

* filter subscriptions: all, requested, trial, paid, read only;
* **activate** a request, recording the payment reference (bank transfer, invoice or contract
  number). This starts a paid period of one calendar month or year at the plan's list price;
* **extend** a trial, by 1 to 90 days;
* **cancel** a paid plan, which then runs to the end of its paid period;
* make an organisation **complimentary**.

Every step is recorded in `subscription_events`, which cannot be changed, and in the audit
trail.

## Enterprise contracts (SUBS-023)

An enterprise contract is a plan agreed with one organisation for a term, at its own price per billing period and with limits that may differ from the plan's. Platform administrators record contracts under **Platform administration → Contracts**:

* **Recording.** A contract has:
  * a reference, such as `ENT/2026/014`;
  * a plan, which can be one that is not offered to others;
  * monthly or annual billing;
  * a price per period, before tax, in the organisation's currency;
  * a start date and a last day, both India time;
  * any limits that differ from the plan's (members, AI requests, uploads);
  * notes.

  With **Start the first period now**, the organisation goes onto the contract's plan and price for a period of one month or year. The contract reference is recorded as that period's payment, and add-ons and any plan request are cleared. Without it, the contract takes over at the next renewal, which is possible only for an organisation already paying. An organisation has at most one contract in force. A contract's terms never change (the `enterprise_contracts` guard refuses it): to change them, end it and record a new one. Recording and ending a contract are audited.
* **While it runs:**
  * Its limits are the ones enforced: members, and AI requests and uploads metered against it, including the Usage pages.
  * Renewals are invoiced at the contract price, with no add-ons or coupons, while the term covers the new period. They are paid online or by bank transfer, like any renewal.
  * The organisation cannot quote, check out or request another plan (409 `CONTRACT_IN_FORCE`). Its Subscription page shows the contract in place of the plans. Extra AI requests can still be bought.
* **Ending.**
  * A renewal whose period starts after the term ends the contract ("The term ended"), and is invoiced at the plan's list price.
  * An administrator can end a contract early, with a reason. The period already paid for runs on.
  * Once a contract ends, the organisation chooses its plan again.
* **API:**
  * `GET /v1/admin/contracts` (platform read).
  * `POST /v1/admin/subscriptions/:orgId/contract { reference, plan, interval, price, startsOn, endsOn, limits, notes, activate }`. `endsOn` is the first day after the term.
  * `POST /v1/admin/contracts/:id/end { reason }` (platform manage).
  * The subscription returns `contract`.
* **Tests:**
  * Engine: `packages/accounting-engine/test/enterprise-contracts.test.ts`.
  * API: `apps/api/test/subscription-enterprise-contracts.e2e.test.ts`.
  * Browser: `apps/web/e2e/subscription-enterprise-contracts-flow.test.mjs`.

## API

| Method | Path | Who |
|---|---|---|
| GET | `/v1/orgs/:orgId/subscription` | Members (`org.read`) |
| POST / DELETE | `/v1/orgs/:orgId/subscription/request` `{ plan, interval }` | Owners and admins (`org.manage`); works while read only |
| GET | `/v1/admin/plans` | Platform read |
| PUT | `/v1/admin/plans/:code` | Super admin |
| GET | `/v1/admin/subscriptions?filter=` | Platform read |
| POST | `/v1/admin/subscriptions/:orgId/activate` `{ paymentReference, plan?, interval? }`, `/extend-trial` `{ days }`, `/cancel` `{ reason }`, `/complimentary` `{ reason }` | Super admin |

Organisations in `GET /v1/orgs` carry `subscription: { plan: { code, name, features }, status, access }`.

## Not built yet (next slices)

* Online checkout, renewals, dunning, subscription invoices and tax: built in slice 3, see
  [`SUBSCRIPTION_PAYMENTS.md`](SUBSCRIPTION_PAYMENTS.md).
* Coupons: built, see [`SUBSCRIPTION_PAYMENTS.md`](SUBSCRIPTION_PAYMENTS.md#coupons-subs-024). Promotions (coupons applied without a code) are built too.
* Add-on modules: built, see [`SUBSCRIPTION_PAYMENTS.md`](SUBSCRIPTION_PAYMENTS.md#add-on-modules-subs-017).
* Counting AI requests and uploads against their limits.
