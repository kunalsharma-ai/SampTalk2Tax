# Dashboards described in words

You describe the dashboard you want, and the AI builds it from approved metrics. For example: *a monthly view for the board, with revenue against last year, margins, cash and runway, and our biggest customers*. Dashboards can also be built by hand.

The AI only chooses which approved metrics to show and how to show them. Every figure is worked out from the posted books by the same engine as the [KPIs](KPIS_AND_MANAGEMENT_REPORTS.md), so the AI never produces a number.

**Reports → Dashboards** (`/orgs/:orgId/reports/dashboards`).

## Approved metrics

There are 23 approved metrics.

The 13 KPIs:
* revenue;
* gross, operating and net margin;
* operating expense ratio;
* current and quick ratio;
* working capital;
* liabilities to equity;
* days sales and days payables outstanding;
* net cash flow;
* cash runway.

10 figures from the books:
* cost of sales;
* gross profit;
* operating expenses;
* payroll;
* operating profit;
* net income;
* cash and bank;
* receivables;
* payables;
* inventory.

Each metric has a unit, a direction (whether higher or lower is better) and a formula. The formula is shown when you hover over a figure.

## Widgets

A dashboard has 1 to 12 widgets, shown in order on a six-column grid. Each widget is small, medium or full width.

| Widget | Settings | Shows |
| --- | --- | --- |
| **Figure** | A metric; compare against the month before, the same month last year, or nothing | The value for the month, with the change marked good or bad by the metric's direction. If there is no value, it says why, for example *No revenue in the month* |
| **Line chart** / **Bar chart** | 1 to 4 metrics with the **same unit**; 3 to 24 months | The metrics by month, with the exact figures in a table under the chart |
| **Table** | 1 to 8 metrics; 1 to 12 months | Monthly values |
| **Top customers** | 3, 5 or 10 customers; 1 to 12 months | Revenue by customer from posted invoices and credit notes, with each customer's share. Needs `sales.read`; without it, the widget says why it is empty |

The engine checks every widget the same way, whether a person built it or the AI drafted it, and explains each problem in words. For example:
* *Widget 2: a chart can only show metrics measured the same way; these mix amounts and percentages*;
* *Widget 1: "ebitda" is not an approved metric*.

In the builder:
* metrics that would mix units in a chart are greyed out;
* **Preview** works out the figures without saving.

A dashboard shows the last complete month by default. Any of the last 13 months can be chosen; the current month shows its figures so far.

## Drafting with AI

**Draft with AI** sends the description to Claude, which calls a `propose_dashboard` tool. The draft contains:
* a name and a purpose;
* the widgets;
* **notes** on anything asked for that is not available, such as balances by bank account, budgets or a product line;
* **questions**.

The person answers the questions and chooses **Revise the draft**. The draft is checked, and if it is valid its figures are worked out and shown. **Use this draft** copies it into the builder. Nothing is saved until the person saves.

Drafting follows the same rules as the copilot:
* the on/off switch, the emergency stop and the monthly budget in the [AI control center](AI_CONTROL_CENTER.md) apply, and its usage counts there;
* each call is recorded in `dashboard_ai_drafts`, with the request, the result or the error, the model and the tokens;
* each call is audited as `dashboard.ai_drafted` or `dashboard.ai_draft_failed`, with the prompt version (`dashboard-draft-1`).

## Saving

Saved dashboards are:
* numbered DB-0001 and so on;
* named uniquely within the organisation;
* visible to everyone with `reports.read`.

Building, changing and deleting dashboards needs `dashboards.manage` (owners, admins, accountants).

Only the configuration is stored. The figures are worked out from the books each time a dashboard is opened. A change that started from an older version is refused, so two people cannot overwrite each other. Changes are audited as `dashboard.created`, `dashboard.updated` (with before and after) and `dashboard.deleted`.

## API

| Route | Permission | |
| --- | --- | --- |
| `GET /v1/orgs/:orgId/dashboards`, `GET …/dashboards/:id?month=` | `reports.read` | Dashboards; one dashboard with its figures for the month |
| `GET …/dashboards/catalogue`, `GET …/dashboards/ai-status` | `reports.read` | Approved metrics, kinds of widget and limits; whether drafting with AI is available |
| `POST …/dashboards/preview` `{ config, month? }` | `reports.read` | Checks a configuration and works out its figures without saving. 422 `INVALID_DASHBOARD` with `details.issues` |
| `POST …/dashboards`, `PUT …/dashboards/:id` `{ …, baseVersion }`, `DELETE …/dashboards/:id` | `dashboards.manage` | Save, change (409 `DASHBOARD_CHANGED` for a stale change) and delete |
| `POST …/dashboards/ai-draft` `{ request, conversation, month? }` | `dashboards.manage` | 503 `AI_NOT_CONFIGURED`, 409 when AI is off, 422 `REFUSED` or `NO_PROPOSAL` |

## Tests

* `packages/accounting-engine/test/dashboards.test.ts` (3) covers:
  * validation, with every problem in words;
  * each kind of widget worked out from month figures, checked by hand;
  * dashboards in words.
* `apps/api/test/dashboards.e2e.test.ts` (4) covers:
  * figures from posted invoices, bills and journals;
  * earlier months;
  * saving, changing and deleting, with the audit trail and the database check;
  * AI drafts with a scripted model, including notes, an invalid draft, a conversation and a refusal, counted in the AI control center;
  * permissions and tenant isolation.
* `apps/web/e2e/dashboards-flow.test.mjs` runs in the browser: it builds, previews, saves, views another month, reorders, removes and deletes a dashboard.

## Limitations

* Organisation-wide figures only. There are no departments, projects, budgets or forecasts on dashboards yet.
* Monthly figures only.
* Live AI drafting waits on a Claude key (tests use a scripted model).
