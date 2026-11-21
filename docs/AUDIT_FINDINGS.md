# Audit findings and remediation (AUDIT-011, AUDIT-012)

Governance → Audit findings keeps each problem that needs fixing. Every finding has:

* a reference (F-001, F-002, …)
* a severity (low, medium, high)
* a remediation owner
* a plan
* a due date

## Raising

* **By hand.** Give a title and describe what was found.
* **From a failed control test.** The failed test on the control's page links to *Raise finding*. The title, and what was found (the check's summary and each exception), come from the test. Each failed test can be raised once (a unique index).

The remediation owner must be a member with `audit.read`. If no due date is given, the finding is due 14 days (high), 30 days (medium) or 60 days (low) after it is raised. A due date cannot be in the past. Anyone with `audit.read` can raise a finding.

## Working on it

Open → In progress → Ready for review. A reviewer can send a finding back from Ready for review to In progress. Only the remediation owner, or an owner or admin, records progress, and each update needs a note of at least 10 characters.

## Closing

* Closing needs `approvals.decide` (owners, admins, approvers), and the person closing cannot be the remediation owner.
* The finding must be Ready for review, and the closer says what they checked.
* A finding raised from a failed control test closes only after that control has a passing test recorded later than the failure, for the same period (tested again once fixed) or a later one. The passing test is kept on the finding.

## Record

* Every step is kept on the finding in order, with who took it and what they said. The list of updates can only grow.
* A closed finding cannot be changed, and findings are never deleted (collection guards).
* Raising, each update and closing are audited (`audit_finding.raised`, `.updated`, `.closed`).
* A finding is overdue once its due date has passed while it is still open.

## Code and tests

* Engine: `packages/accounting-engine/src/audit-findings.ts`, `test/audit-findings.test.ts`
* API: `apps/api/src/audit-findings/`, collection `audit_findings`, `test/audit-findings.e2e.test.ts`
* Web: `apps/web/src/app/orgs/[orgId]/audit-findings/`, `e2e/audit-findings-flow.test.mjs`
