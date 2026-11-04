# Financial recovery planner

The recovery planner helps a business protect its cash. It works out options from the organisation's own books, measures each one with the [digital twin](DIGITAL_TWIN.md), and lets the team build a plan with owners, due dates and progress.

**Nothing is done automatically.** The planner never contacts customers or suppliers, cuts costs, borrows, pays, or changes payroll. Options are proposals, and people carry them out (RECOV-011). The API and browser tests check that no journal, payment or loan is created.

## Pages

**Planning → Recovery planner** (`/orgs/:orgId/planning/recovery`) shows:

* where cash is heading with no action: when it runs out, the runway, the lowest cash, the cash to raise, and how many days customers and suppliers take to pay;
* the options, grouped by kind;
* the plans, and a form to start a new one.

A plan (`/planning/recovery/:planId`) shows:

* how long cash lasts, the lowest cash and the cash still to raise, with no action and with the plan;
* the liquidity forecast chart and the risks of the plan;
* each action with its status, owner, due date and note;
* the options not yet in the plan, each with **Add to plan**.

## Options

Options are worked out again each time from:

* the last 3, 6 or 12 months of posted figures (the same baseline as the twin);
* overdue invoices (the receivables ageing);
* posted supplier bills in those months, in the functional currency;
* the operating expense accounts.

Each option is a set of twin changes. Its effect is measured by running the twin with it and without it: on lowest cash, cash at the end, net profit, and whether cash still runs out.

| Kind | Option | How it is worked out | Twin change |
|---|---|---|---|
| Collect faster | Chase overdue invoices | Overdue amounts up to 90 days late count as recoverable; older debt is listed but not counted. Lists the customers, largest first | Customers pay sooner, by the recoverable amount in days of revenue (no more than the current collection days) |
| Collect faster | Shorten payment terms for new invoices | Only when customers take 20 days or more to pay | 10 days sooner from month 2 |
| Suppliers | Ask suppliers for longer payment terms | Suppliers by average monthly bills, largest first | Suppliers paid 15 days later |
| Suppliers | Renegotiate supplier prices by 3% | Only when there is cost of sales | Supplier costs −3% from month 2 |
| Reduce costs | Cut *account* by 20% (the five largest operating cost lines) | Average monthly spend on the account | A fifth of it less each month |
| Conserve cash | Freeze non-essential spending | Other operating costs | −10% |
| Financing | Arrange a working capital loan | Only when cash falls short. Sized at 1.1 times the gap, then raised (up to twenty times) until the repayments no longer open a new gap | A 2-year loan at 12%, received the month before cash runs out |
| Financing | Raise money from owners or investors | Only when cash falls short | New capital of 1.1 times the gap, not through profit |
| Revenue | Raise prices by 5% | When there is revenue | Prices +5% with 2% fewer sales, from month 2 |
| Restructuring | Reduce payroll costs by 10% | When there is payroll | Payroll −10% from month 3 |

Options that involve borrowing, contracts or people are marked **Needs a decision**: longer supplier terms, supplier prices, loans, new capital and payroll. The payroll option only models lower cost, for example through a hiring freeze or not replacing leavers. It says plainly that it is not a recommendation to let anyone go.

The freeze on non-essential spending overlaps with the individual cost cuts. Adding both counts some savings twice, and the option says so.

## Plans

* A plan has a name, its baseline and horizon, and a status:
  * **Draft** can be deleted.
  * **Active** cannot be deleted. Close it instead so its history is kept.
  * **Closed** is read-only until reopened.
* **Add to plan** stores the option as it stands that day: its changes, the customers or suppliers it names, and its risks. Each option can be added once.
* Each action has a status (Planned, In progress, Done, Dropped), an owner (a member of the organisation), a due date and a note. Dropped actions are left out of the forecast.
* The forecast runs every action that is not dropped together against no action, using today's books.
* An action whose option the books no longer suggest is marked "No longer suggested by the books". For example, the overdue invoices may have been paid.
* **Open as a twin scenario** copies the plan's actions (except dropped ones) into a new digital-twin scenario called "Recovery: *plan*". There it can be refined and taken through the [war room](WAR_ROOM.md) approval.

Everything is audited:

* `recovery_plan.created`, `.updated`, `.activated`, `.closed`, `.returned_to_draft`, `.deleted`
* `recovery_action.added`, `.updated`, `.removed`

## Permissions

* Reading options and plans needs `reports.read`.
* Creating and changing plans needs `scenarios.manage` (owners, admins and accountants).
* Plans are tenant rows with forced row-level security. An action can only belong to a plan of the same organisation, which a composite foreign key enforces.

## API

All routes are under `v1/orgs/:orgId/recovery`:

| Method and path | Purpose |
|---|---|
| `GET options?baselineMonths=3\|6\|12&horizonMonths=1..60` | No-action summary and the options with their effect |
| `GET plans`, `POST plans` `{ name, description?, baselineMonths, horizonMonths }` | List (with action counts) and create |
| `GET plans/:id` | The plan, actions, owners' names, the forecast, the options not in the plan, and stale actions |
| `PUT plans/:id` `{ name?, description?, status? }` | Rename, start, close or reopen |
| `DELETE plans/:id` | Delete a draft |
| `POST plans/:id/actions` `{ optionKey }` | Add an option |
| `PUT plans/:id/actions/:actionId` `{ status?, ownerId?, dueDate?, note? }` | Track it |
| `DELETE plans/:id/actions/:actionId` | Remove it |
| `POST plans/:id/scenario` | Copy into a twin scenario; returns `{ scenarioId, name }` |

## Tests

* `packages/accounting-engine/test/recovery.test.ts` (6) covers:
  * the no-action summary;
  * the full list of options and the effect of each;
  * recoverable debt and the people to talk to;
  * loan sizing;
  * which options need a decision;
  * a plan forecast with and without a loan;
  * a healthy business getting no financing or collection options.
* `apps/api/test/recovery.e2e.test.ts` (6) covers:
  * options from real invoices, bills and journals;
  * plans and actions with permissions;
  * owners who must be members;
  * dropped actions leaving the forecast;
  * plan status rules;
  * copying a plan into a twin scenario;
  * tenant isolation;
  * the audit trail;
  * that nothing is posted, paid or borrowed.
* `apps/web/e2e/recovery-flow.test.mjs` does the whole flow in the browser.

## Not built yet

* Options and plans are not written or explained by AI. The options are rules measured on the twin (RECOV-001 is "Implementing").
* The percentages in the options are fixed (20% cuts, 15 days, 3%, 5%, 10%). To try other figures, open the plan as a twin scenario.
* No reminders when actions fall due, and no link to the task queue.
* Supplier spend comes from posted bills only. Purchases booked straight to journals are not attributed to a supplier.
