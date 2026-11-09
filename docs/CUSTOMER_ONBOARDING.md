# Customer onboarding (AR-003)

Before a new customer is invoiced, the organisation collects what it needs about them and a second
person approves it. Approval sets the customer's credit limit and payment terms.

## What an onboarding checks

**Read from the customer record** (always, so they cannot disagree with it):

* an email for invoices and statements;
* the billing address, with its six-digit PIN code in India;
* in India a GSTIN or (for an unregistered customer) a PAN; elsewhere a tax number;
* a proposed credit limit (0 = payment in advance) and payment terms (0 to 365 days).

**The organisation's own checklist** (Sales → Customer onboarding → Onboarding checklist, owners and
admins): items such as KYC documents, a signed agreement or a credit check. An item marked
**File needed** is done only with a file attached to the onboarding. The default checklist has
proof of registration, a signed agreement and a credit check. Each onboarding copies the checklist
when it starts, so later changes do not alter onboardings already under way.

## Starting one

* **Onboard every new customer before invoicing them** (the checklist page) starts an onboarding by
  itself for every customer added from then on, including a contact that becomes a customer and a
  lead converted to a customer (a database trigger on `contacts`).
* **Start onboarding** on any customer's page starts one by hand.

Customers that already existed when the setting was switched on are not affected.

## Steps

1. **In progress**: fix details with Edit on the customer, attach files and mark items done, save the
   proposed terms.
2. **Submit for approval** once nothing is missing (the page lists what is).
3. **Waiting for approval**: nothing changes, files included. **Take back** returns it to progress.
4. Someone with `approvals.decide` **approves** (the customer's credit limit and payment terms are set
   from the proposal) or **rejects** with a reason. The person who submitted it cannot decide,
   unless nobody else in the organisation can approve; that is recorded as self-approved.
5. A rejected onboarding can be **reopened**, fixed and submitted again. An approved one is final.

While a customer has an onboarding that is not approved, posting an invoice to them is refused
(`ONBOARDING_INCOMPLETE`). Drafts can still be prepared.

## Data and guards

Migration `20261207090000_customer_onboarding`: `customer_onboarding_settings`,
`customer_onboarding_requirements`, `customer_onboardings` (one per customer) and
`customer_onboarding_checks`, all with row-level security. Attachments gain the
`CUSTOMER_ONBOARDING` record type (files only while the onboarding is in progress).

* `t2t_check_customer_onboarding`: never deleted, keeps its customer, approved is final, submitted
  only moves to approved, rejected or back to in progress, rejected only reopens.
* `t2t_check_customer_onboarding_check`: items change only while in progress, keep what they ask
  for, and a file must belong to the same onboarding; a check constraint needs the file for a done
  file item.
* The status check constraint requires who and when for submitting and deciding, terms for approval,
  a reason for rejection, and a different approver unless self-approved.

Every step is in the audit trail.

## API

| Method | Path | Permission |
| --- | --- | --- |
| GET / PUT | `/v1/orgs/:orgId/sales/onboarding-settings` | sales.read / org.manage |
| GET | `/v1/orgs/:orgId/sales/onboardings?status=` | sales.read |
| GET / POST | `/v1/orgs/:orgId/sales/customers/:contactId/onboarding` | sales.read / sales.manage |
| GET / PUT | `/v1/orgs/:orgId/sales/onboardings/:id` | sales.read / sales.manage |
| PUT | `/v1/orgs/:orgId/sales/onboardings/:id/checks/:checkId` | sales.manage |
| POST | `…/onboardings/:id/submit`, `/withdraw`, `/reopen` | sales.manage |
| POST | `…/onboardings/:id/decide` `{ approve, note }` | approvals.decide |

## Tests

Engine `test/customer-onboarding.test.ts`; API `test/customer-onboarding.e2e.test.ts` (7);
browser `e2e/customer-onboarding-flow.test.mjs`.

Not built yet: a customer filling in their own details through a portal link, and vendor
onboarding (AP-002).
