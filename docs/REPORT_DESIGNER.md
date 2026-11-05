# Report designer

Design a management report once, then produce it every month. A report is a list of sections in any order:

* **Headings**.
* **Fixed text**: words that stay the same every month, such as who the report is for or a sign-off. Fixed text never carries figures.
* **Monthly commentary**: an instruction saying what the commentary should cover, for example *explain how revenue and margins moved against last year*. The words are written each month from that month's figures.
* **Figures**: the same widgets as [dashboards](AI_DASHBOARDS.md) (a figure with a comparison, line or bar chart, table, largest customers), using the 23 approved metrics.

A design has 1 to 30 sections and at least one section of figures.

**Reports → Report designer** (`/orgs/:orgId/reports/designer`).

## Designing with the AI

Describe the report in words, for example *a monthly report for the board: how revenue and margins moved against last year, cash and runway, who owes us, and our biggest customers, with commentary on each*.

The AI (Claude, through the [AI control center](AI_CONTROL_CENTER.md) guard, counted in the copilot's usage and budget) proposes:

* a name and description;
* the sections, each checked by the engine exactly as a hand-built design is;
* notes on anything asked for that is not available, such as budgets, departments, forecasts or notes to the accounts;
* short questions. You answer them and ask the AI to revise the draft.

Nothing is saved until you use the draft and save the design. You can also build or change any design by hand. **Preview** works out the figures from the books without saving.

## Producing a report

On a design, choose the month and **Produce report**. The engine works out every figure for that month from the posted books and freezes them in the report, numbered RPT-0001, RPT-0002 and so on. Later changes to the books, or to the design, do not change a report already produced.

The frozen figures are also written out as **facts** in words, for example *Revenue for 2026-10 is INR 250000.00; 2026-09 was INR 100000.00, a change of INR 150000.00*. The facts are shown under the report.

## Commentary

Commentary is written from the facts, by the AI or by a person.

* **By the AI**: when the report is produced (if the AI is available and *Have the AI write the commentary* is ticked), or later with **Write the commentary with AI**, which rewrites every commentary section. The AI sees only the facts and the instructions. If its text quotes any number not in the facts, that text is thrown away and the section says why, so nothing invented reaches a report.
* **By a person**: each commentary section of a draft can be written or edited. Numbers not in the facts are flagged ("Numbers not in the report's figures: …") so they can be checked before finalising. They are flagged rather than blocked because a person may add context the books do not hold.

Numbers match when they are the same value, so ₹2,50,000 matches INR 250000.00. Small whole numbers (up to 12) are allowed for counts and months.

Each section shows whether it was written by the AI or by a person.

## Finalising

**Finalise** makes the report a record. Every commentary section must be written first. A final report can never be changed or deleted; a database trigger enforces this as well as the API. Draft reports can be deleted. A design with reports cannot be deleted.

**Print** prints the report without the editing controls.

## Permissions

* Viewing designs and reports, and previewing, needs `reports.read`.
* Designing, producing reports, writing commentary (by hand or with the AI), finalising and deleting need the new `reports.design` (owners, admins and accountants).
* Largest-customer sections need `sales.read` when the figures are worked out.

Every change is audited: `report_design.created`, `report_design.updated`, `report_design.deleted`, `report.produced`, `report.commentary_edited`, `report.commentary_written`, `report.finalised`, `report.deleted`, plus `report.ai_called` and `report.ai_call_failed` for each AI call.

## API

All under `v1/orgs/:orgId/report-designer`:

| Route | What it does |
| --- | --- |
| `GET catalogue`, `GET ai-status` | Widget kinds, metrics and limits; whether the AI can be used and why not |
| `POST preview` | Figures for a layout without saving |
| `POST ai-draft` | A layout drafted from instructions (with the conversation so far). Nothing is saved |
| `GET/POST designs`, `GET/PUT/DELETE designs/:id` | Designs. `PUT` takes `baseVersion` and gives 409 if someone changed the design meanwhile; `DELETE` gives 409 if reports were produced from it |
| `POST designs/:id/reports` | Produce a report `{ month?, writeCommentary, title? }` |
| `GET/DELETE reports/:id` | A report; deleting works for drafts only |
| `PUT reports/:id/commentary` | `{ section, text, baseVersion }` |
| `POST reports/:id/write-commentary`, `POST reports/:id/finalise` | `{ baseVersion }` |

## Database

* `report_designs`: number, unique name, description, layout (1 to 30 sections, checked in the database and by the engine), version.
* `report_runs`: number, month, title, frozen content (layout, currency, figures, facts), commentary, status `DRAFT` or `FINAL`, version, who finalised and when. A composite foreign key keeps each report with a design of the same organisation. The trigger `t2t_report_runs_final` stops any change to or deletion of a final report.
* `report_ai_calls`: the request, result or error, model and tokens of each AI call.

All three have forced row-level security on `org_id`.

## Limitations

* Live AI drafting and commentary wait on a Claude key; tests use a scripted model.
* Organisation-wide monthly figures only, as for dashboards. Departments, projects, budgets and forecasts are not yet available as sections.
* There is no PDF export of a designed report yet; use **Print** (the browser can save as PDF).
