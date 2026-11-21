# Segregation of duties (AUDIT-014)

Approval rules already stop one person giving both approvals on a covered document, and a payment
batch or a vendor's bank details need a second person whenever there is one. The segregation-of-duties
page (Governance → Segregation of duties) looks at what actually happened in the books over a period
and names each place one person did two jobs that should be split.

## Checks

| Check | What it looks at |
| --- | --- |
| Journal prepared and posted by the same person | Posted manual journals whose author also posted them. Journals the system posts (depreciation, payroll, documents) are not counted. |
| Bill entered and posted by the same person | Posted (or later voided) bills whose author also posted them. |
| Payment batch approved by the person who prepared it | Batches approved by their preparer, which is allowed only when no one else can approve. |
| Vendor bank details changed, then paid by the same person | A payment to a vendor recorded by someone who changed that vendor's bank details on or before the payment date (changes up to a year before the period are read). |
| Bank reconciled by the person who recorded its payments | A completed reconciliation whose period covers payments on that bank account recorded by the person who reconciled it. |

The period is the last 90 days by default and at most 400 days. The page also lists, for every
member who can change the books, the pairs of duties their role lets them do on their own
(preparing and posting journals, setting up vendors and paying them, recording bank payments and
reconciling the bank, preparing bills and payments and approving them, preparing payroll and
posting it).

## Reviewing a finding

A finding is cleared by a review: someone with `approvals.decide` (owners, admins, approvers) who
was not one of the people involved writes what they checked (at least 10 characters). The API
looks the finding up again from the books before saving, so only a real finding on that date can
be reviewed. Each finding is reviewed once; reviews are never changed or deleted (collection
guards) and each one is written to the audit trail as `sod.finding_reviewed`.

In an organisation where only one person does the work, no one can clear the findings. The page
says so and suggests adding an approver, such as an outside accountant.

## Permissions

Reading needs `audit.read` (owners, admins, accountants, approvers). Reviewing needs
`approvals.decide`. Nothing on the page changes the books.

## Code and tests

* Engine: `packages/accounting-engine/src/segregation-of-duties.ts`, `test/segregation-of-duties.test.ts`
* API: `apps/api/src/segregation-of-duties/`, collection `sod_reviews`, `test/segregation-of-duties.e2e.test.ts`
* Web: `apps/web/src/app/orgs/[orgId]/segregation-of-duties/page.tsx`, `e2e/segregation-of-duties-flow.test.mjs`
