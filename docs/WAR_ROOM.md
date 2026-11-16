# Scenario war room

The war room is where a team works on a digital-twin scenario together and takes it to a decision. It builds on the [digital twin](DIGITAL_TWIN.md). Every figure is hypothetical, and nothing is posted to the ledger.

Open **Planning → Digital twin** and pick a scenario. The page has three parts:

* **Left:** the scenario settings and its changes. Each change can be assigned to a department.
* **Centre:** the projection, recalculated as you type. It has the cash chart, key risks, inputs to confirm, what each change does, suggested next moves and the month-by-month table.
* **Below:** the approval bar (at the top), the team's notes and the version history.

## What each change does

Each change is measured by running the scenario once without it. For example, "Hiring: net profit −1,100,000" means the scenario's 12-month net profit is that much lower with the hiring than without it.

Changes can strengthen or offset each other. For example, a price rise on top of growth earns more than either one alone. That difference is shown on its own row, **Acting together**, so the rows always add up to **All changes**.

Totals are rounded separately, so an impact can be a paisa away from the exact cost.

When changes are assigned to departments ([Departments and projects](FINANCIAL_DIMENSIONS.md)), the page also shows the total effect for each department. A department from another organisation is refused.

## Suggested next moves

Each suggestion is tested by running the scenario again with the suggestion applied. Its effect on net profit, cash at the end, and whether cash still runs out is shown beside it.

**Try this** adds the suggestion to the changes, or for the three-months-later suggestion replaces the change. Nothing is saved until you save.

| Suggestion | When it appears | What it tries |
|---|---|---|
| Arrange funding before cash runs out | Cash runs out | A 3-year loan at 11%, received the month before cash runs out. It is sized at 1.1 times the shortfall, then raised (up to twenty times) while the repayments open a new gap. The text says plainly if cash still runs out. |
| Collect from customers sooner | Customers take 20 days or more to pay, and it would release cash | Collecting 10 days sooner from month 1 |
| Test a price rise | The scenario makes less profit than no change, or a loss, and the rise would add profit | Prices +5% from month 2, with 2% less volume |
| Start the costliest change three months later | Cash runs out or there is a loss, and the costliest hiring, expense, expansion, investment or supplier change can start three months later and that helps | The same change three months later, replacing it |
| Include income tax | No tax rate is known, the scenario is profitable and the organisation reports in INR | 25.17%, the rate for companies under section 115BAA. Use your own rate if it is different. |

The suggestions are rules, not advice written by AI, and they are hypothetical like the rest of the scenario.

## Versions

Every save that changes the inputs creates a new version (1, 2, 3…). A version records the name, description, baseline, horizon and changes, who saved it, when, and why: created, edited, or restored from version n. Versions can never be changed or deleted; the database refuses it.

**Restore** makes an earlier version the newest one. Nothing is lost.

Saving the same inputs again does not create a version. Two people saving at the same time cannot overwrite each other: the second is told to reload.

## Notes

Anyone who can read reports can add a note. A note can be pinned to a projected month, to one of the changes, or both. It records the version it was written on.

The author, or anyone who manages scenarios, can resolve a note or open it again. Only the author can delete it. The board shows how many notes are open on each scenario.

## Approval

| Status | Meaning | Who can move it |
|---|---|---|
| Draft | Being worked on | People who manage scenarios submit it |
| Waiting for approval | Frozen: it cannot be edited, restored or deleted | The submitter's team can withdraw it. Someone with `scenarios.approve` (owners, admins, approvers) approves or rejects it. |
| Approved | Frozen | People who manage scenarios can reopen it as a draft |
| Rejected | Has a reason from the approver. Editing it returns it to draft. | Submit again |

* The person who submitted a scenario cannot approve or reject it, even as owner.
* A rejection needs a reason.
* Every step is audited as `twin_scenario.submitted`, `.withdrawn`, `.approved`, `.rejected` and `.reopened`.
* Approving a scenario records a decision only. It does not post anything or change any budget.

## Planning board and risk map

The **Planning board** on the Digital twin page groups scenarios by status. Each card shows its changes, version, open notes, and who submitted or decided it. Pick up to five scenarios to compare.

The comparison shows each scenario's approval status and a **Risk map**. Each row is one kind of risk the twin finds, for example cash running out, a loss, a thin margin, growing receivables or loan payments barely covered. Each column is one scenario, with the level of that risk. Hover a level for the details.

## API

All routes are under `v1/orgs/:orgId/twin/scenarios/:id`:

| Method and path | Permission | Purpose |
|---|---|---|
| `GET` | reports.read | The scenario, with its run (including `insights`), versions, notes and the names of the people involved |
| `POST versions/:version/restore` | scenarios.manage | Restore a version as the newest |
| `POST submit`, `POST withdraw`, `POST reopen` | scenarios.manage | Approval steps |
| `POST approve`, `POST reject` `{ note }` | scenarios.approve | Decide (not on your own submission; a rejection needs a note) |
| `POST notes` `{ body, month?, changeNumber? }` | reports.read | Add a note |
| `PUT notes/:noteId` `{ resolved }` | reports.read (author) or scenarios.manage | Resolve or reopen |
| `DELETE notes/:noteId` | reports.read (author only) | Delete |

`POST …/twin/simulate` also returns `insights`: `impacts`, `interaction`, `departments`, `suggestions` and `total`.

## Tests

* `packages/accounting-engine/test/twin-insights.test.ts` covers impacts and interaction, departments, funding that keeps cash positive, and when each suggestion appears.
* `apps/api/test/war-room.e2e.test.ts` covers:
  * impacts by department and the suggested loan clearing the gap;
  * a department from another organisation;
  * versions with restore;
  * notes with pins and who may resolve or delete;
  * the full approval flow with self-approval, frozen states and rejection reasons;
  * the audit trail;
  * tenant isolation.
* `apps/web/e2e/war-room-flow.test.mjs` runs the whole flow in two browsers: an owner and an approver.

## Not built yet

* Live collaboration. Others see changes when they reload; there is no presence, no live cursors and no notifications for notes.
* Recommendations written by AI. The suggestions are rules measured on the model.
* Budget simulations linked to the budgets module.
* Approval of a scenario does not feed into budgets or the cash-flow forecast.
