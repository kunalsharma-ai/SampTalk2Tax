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

**Online payment is not built in this slice.** The page says so: Talk2Tax sends an invoice
and activates the plan when payment is received. Until then nothing changes.

Platform administrators open **Platform administration → Subscriptions**, where they can:

* filter subscriptions: all, requested, trial, paid, read only;
* **activate** a request, recording the payment reference (bank transfer, invoice or contract
  number). This starts a paid period of one calendar month or year at the plan's list price;
* **extend** a trial, by 1 to 90 days;
* **cancel** a paid plan, which then runs to the end of its paid period;
* make an organisation **complimentary**.

Every step is recorded in `subscription_events`, which cannot be changed, and in the audit
trail.

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

* Online checkout with a payment gateway, set up in the app.
* Automatic renewal, payment-failure handling and dunning.
* Subscription invoices, and tax on subscriptions.
* Coupons and promotional prices.
* Add-ons.
* Proration on upgrade. The engine's `upgradeCharge` is ready for it, but no checkout uses it
  yet.
* Counting AI requests and uploads against their limits.
