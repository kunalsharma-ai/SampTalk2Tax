# Vendor onboarding (AP-002)

Before a new vendor's bills are posted or they are paid, the organisation collects what it needs
about them and a second person approves it. Approval sets the vendor's payment terms. It works the
same way as [customer onboarding](CUSTOMER_ONBOARDING.md) and shares its tables (`party = 'VENDOR'`),
with its own setting, checklist, permissions and wording.

## What an onboarding checks

**Read from the vendor record** (always):

* an email for remittance advice;
* the address, with its six-digit PIN code in India;
* in India a GSTIN or (for an unregistered vendor) a PAN; elsewhere a tax number;
* bank details entered **and verified** (Purchases → vendor → Bank details; verification needs
  `approvals.decide` and someone other than the person who entered them, unless nobody else can);
* agreed payment terms (0 to 365 days). A vendor onboarding never carries a credit limit.

**The organisation's own checklist** (Purchases → Vendor onboarding → Onboarding checklist, owners and
admins). The default has a GST certificate or PAN card, a cancelled cheque or bank letter, and an
MSME (Udyam) status check. Each onboarding copies the checklist when it starts.

## Starting one

* **Onboard every new vendor before posting their bills or paying them** starts one by itself for
  every vendor added from then on (the same `contacts` trigger, per party setting). Customer and
  vendor settings are independent; a contact that is both gets one onboarding of each.
* **Start onboarding** on any vendor's page starts one by hand.

## Steps and approval

Work through the panel on the vendor's page, save the payment terms, **Submit for approval**. Someone
with `approvals.decide` other than the submitter approves (self-approval only when nobody else can)
or rejects with a reason; a rejected onboarding can be reopened. Every step is in the audit trail
as `vendor_onboarding.*`.

## What it blocks

While a vendor has an onboarding that is not approved:

* posting a bill from them is refused (`409 ONBOARDING_INCOMPLETE`);
* recording a payment to them is refused (same error).

Vendors with no onboarding are not affected.

## API

Under `/v1/orgs/:orgId/purchases` (permissions `purchases.*`): `onboarding-settings` (GET/PUT),
`onboardings` (list), `onboardings/:id` (GET/PUT terms), `onboardings/:id/checks/:checkId`,
`/submit`, `/withdraw`, `/decide`, `/reopen`, and `vendors/:contactId/onboarding` (GET/POST start).

## Tests

* Engine: `packages/accounting-engine/test/customer-onboarding.test.ts` (vendor checks).
* API: `apps/api/test/vendor-onboarding.e2e.test.ts`.
* Browser: `apps/web/e2e/vendor-onboarding-flow.test.mjs`.

Not built: a vendor self-service portal for vendors to upload their own documents.
