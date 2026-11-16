# Decision memory

Decision memory keeps a searchable history of approved management decisions. For each one it records the assumptions behind it and the outcomes it was expected to produce. It then measures what actually happened in the books and keeps the lessons learned.

**Planning → Decision memory** (`/orgs/:orgId/decisions`).

## Recording a decision

A decision has:

* a title, what was decided, and why (the situation and the options considered);
* a category (pricing, hiring and people, cost control, investment, funding, credit and collections, suppliers, growth, other) and tags;
* the date it was taken and who took it (a person or a meeting);
* an optional date to review it;
* **assumptions**: what has to be true for it to work;
* **expected outcomes**: a measure from the books, *at least* or *at most* a target, in a given month. The measures are the KPIs: revenue, gross, operating and net margin, operating expense ratio, current and quick ratio, working capital, liabilities to equity, collection and payment days, net cash flow and cash runway.

Each expected outcome stores the measure's value in the **month before the decision**, so the result can be compared with where the business started.

Decisions are numbered DM-0001, DM-0002 and so on.

### From an approved scenario or a recovery plan

An **approved** war-room scenario has a *Record as a decision* link. The draft takes:

* the scenario's name and description;
* who approved it, when, and the approval note;
* the scenario's assumptions in words.

An active or closed recovery plan has the same link. Its draft lists the plan's actions with owners and due dates. In both cases you add the expected outcomes yourself. The decision links back to its source.

## Measuring outcomes

Once an outcome's month is over, its value is worked out from the posted books for that month (`computeKpis` over the month and the two before it, as on the KPIs page). The result is one of:

* **Met** or **Missed**, with the change since before the decision and a sentence saying what happened. For example: *Met: gross margin was 40.0% in Oct 2026, against 30.0% before the decision. Expected at least 35.0%.*
* **Not due yet**, while the month is still running.
* **No value**, when the books cannot give one, such as a margin in a month without revenue.

While a decision is active, outcomes are re-measured every time it is opened. Postings made later, such as corrections, are therefore reflected. The suggested verdict is:

* *worked* when every measured outcome was met;
* *did not work* when none was;
* *partly* otherwise.

## Reviewing

The review records:

* whether each assumption held (*held*, *did not hold*, *not known*), with a note;
* the verdict (worked, partly worked, did not work), with the suggested one chosen to start with;
* what happened;
* the lessons learned (required).

Reviewing **freezes** the measured outcomes as they are at that moment. After that, a reviewed decision cannot be changed. The API refuses with 409, and a database trigger refuses any update or delete of a reviewed or withdrawn row.

A decision that was reversed or never carried out can be **withdrawn** with a reason. It stays in the history.

## Searching

Search matches every word typed against:

* the number, title, decision and context;
* who decided;
* the tags and assumptions;
* what happened, the lessons and the withdrawal reason.

The list can also be filtered by category, status and verdict. It shows how many decisions are active, due for review, reviewed and withdrawn.

## API

| Endpoint | Permission | |
|---|---|---|
| `GET /v1/orgs/:orgId/decisions?q=&category=&status=&verdict=` | `reports.read` | Up to 200 decisions, newest first, with outcome counts, totals and the lists of categories, verdicts and measures |
| `GET …/decisions/meta` | `reports.read` | Categories, verdicts and measures |
| `GET …/decisions/:id` | `reports.read` | The decision with its outcomes measured, the suggested verdict, its source and the people involved |
| `GET …/decisions/draft?sourceType=SCENARIO\|RECOVERY_PLAN&sourceId=` | `decisions.manage` | A prefilled draft (nothing is saved); a scenario must be approved |
| `POST …/decisions` | `decisions.manage` | Record a decision |
| `PUT …/decisions/:id` | `decisions.manage` | Change an active decision |
| `POST …/decisions/:id/review` | `decisions.manage` | Review it: `{ verdict, outcomeNotes, lessons, assumptions: [{ held, note }] }` |
| `POST …/decisions/:id/withdraw` | `decisions.manage` | Withdraw it: `{ reason }` |

Validation errors are 400. Rules the input breaks return 422, for example a future decision date, an outcome measured before the decision, the same measure twice for one month, or a source from another organisation. Changing a reviewed or withdrawn decision returns 409.

## Security

* `decisions.manage` is held by owners, admins, accountants and approvers. Viewers can read but not record.
* Employees cannot see decisions.
* Every recording, change, review and withdrawal is audited (`decision.recorded`, `decision.updated` with before and after, `decision.reviewed` with the frozen figures, `decision.withdrawn`).
* The table is tenant-scoped with forced row-level security. Sources must belong to the same organisation.

## Tests

* `packages/accounting-engine/test/decisions.test.ts` (5): baseline months, checks, the explanation and change for each status, the suggested verdict, and search terms.
* `apps/api/test/decisions.e2e.test.ts` (6): measuring from the books against the month before; validation; search and filters; withdrawal; editing; review freezing the figures even after later postings; the database trigger; drafts from a recovery plan and from an approved scenario only; permissions; tenant isolation; and the audit trail.
* `apps/web/e2e/decision-memory-flow.test.mjs`: the whole flow in the browser.

## Limitations

* Outcomes are KPIs of the whole organisation. A decision about one department or project cannot yet be measured on that department or project alone.
* Nobody is reminded when a review is due; the list shows decisions due for review.
* Search is word matching, not semantic search. The copilot cannot yet search decision memory.
* A recovery plan's draft does not copy the plan's measured effect into expected outcomes.
