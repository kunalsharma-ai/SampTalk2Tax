# Internal controls register (AUDIT-008, AUDIT-013)

Governance → Controls register keeps the checks that keep the books right. Each control has an owner,
an area, a frequency (monthly, fiscal quarter or fiscal year), and a test recorded for each period
once it has ended.

## Controls

Owners and admins (`org.manage`) add controls in two ways:

* **From the library.** Each library control can be added once. Four of them are checked against the books:

  | Library control | Automatic check for the period |
  | --- | --- |
  | Bank accounts reconciled monthly | Every active bank account with posted entries up to the period end has a completed reconciliation to at least the period end |
  | Manual journals posted by a second person | Every posted manual journal in the period was posted by someone other than its author, or that segregation-of-duties finding was reviewed |
  | Vendor bank detail changes verified | Every vendor's bank details changed by the period end are verified |
  | Closed months locked | Every accounting period that ended by the period end is locked or closed |

  The library also has receivables review, member access review (quarterly) and tax return review. These are tested by hand.
* **Written by the organisation.** These controls are tested by hand.

The owner must be a member who works on the books. Changing a control's wording, owner, frequency
or use is audited as `control.updated` with the before and after values.

## Testing

Each control is tested for the latest period that has ended. A test is due for 15 days after the
period ends, then overdue. Statuses: Passed, Failed, Due, Overdue, Not in use. The latest test for
the period counts, so a failed period can be tested again once it is fixed.

* **Automatic checks.** *Run check* shows the outcome without recording anything. *Record test* works the check out again on the server and keeps the result with its evidence: a summary and each exception. The tester cannot type the result.
* **Manual controls.** Manual tests need the result and at least 10 characters on what was checked.
* **Who can test.** Anyone with `audit.read` can test. The control's owner cannot test their own control while anyone else can; when no one else can, the test is marked *Owner tested own control*.
* **Records.** Tests are never changed or deleted (collection guards), and each one is audited as `control.tested`.

## Code and tests

* Engine: `packages/accounting-engine/src/internal-controls.ts`, `test/internal-controls.test.ts`
* API: `apps/api/src/internal-controls/`, collections `internal_controls` and `control_tests`, `test/internal-controls.e2e.test.ts`
* Web: `apps/web/src/app/orgs/[orgId]/controls/`, `e2e/controls-register-flow.test.mjs`
