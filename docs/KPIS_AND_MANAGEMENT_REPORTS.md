# KPIs and management reports (M4, slice 3)

**KPIs** shows 13 financial KPIs for a month, worked out from posted journals. Each KPI comes with the figures behind it, its last 13 months and a target. **Management reports** gives each month one report: the profit and loss against the previous month, the same month a year earlier and the approved budget, plus cash, KPIs, top customers and commentary. Finalising a report freezes it.

* **Rules:** `packages/accounting-engine/src/kpis.ts`: grouping by account subtype, the P&L lines, the KPIs, targets, changes and customer concentration. It has no framework or database code.
* **API:** `apps/api/src/kpis`.
* **Web:**
  * **Reports → KPIs**.
  * **Reports → Management reports**, with a page for each month that can be printed from the browser.

## Where the numbers come from

Everything is read from **posted** journals, so drafts never count. Amounts are in the functional currency. Months are calendar months. The KPI page opens on the last complete month in India time, and a month still in progress is labelled as such.

Accounts are grouped by subtype:

| Group | Subtypes |
|---|---|
| Revenue | revenue except `OTHER_INCOME` |
| Other income | `OTHER_INCOME` |
| Cost of sales | `COST_OF_SALES` |
| Operating expenses | `OPERATING_EXPENSE`, `PAYROLL_EXPENSE`, `DEPRECIATION` |
| Interest, income tax | `INTEREST_EXPENSE`, `TAX_EXPENSE` |
| Other expenses | `OTHER_EXPENSE`, `FX_GAIN_LOSS`, expenses without a subtype |
| Cash | `CASH`, `BANK` |
| Current assets | cash, `ACCOUNTS_RECEIVABLE`, `INVENTORY`, `PREPAID`, `TAX_RECEIVABLE`, `OTHER_CURRENT_ASSET` |
| Non-current assets | every other asset, **including assets without a subtype** |
| Non-current liabilities | `LONG_TERM_DEBT`, `OTHER_NON_CURRENT_LIABILITY` |
| Current liabilities | every other liability, **including liabilities without a subtype** (the cautious reading) |

Equity is assets less liabilities, so it includes the earnings to date.

## The KPIs

| KPI | Formula | Better |
|---|---|---|
| Revenue | Operating revenue in the month | higher |
| Gross margin | (revenue − cost of sales) ÷ revenue | higher |
| Operating margin | (revenue − cost of sales − operating expenses) ÷ revenue | higher |
| Net margin | net income ÷ (revenue + other income) | higher |
| Operating expense ratio | operating expenses ÷ revenue | lower |
| Current ratio | current assets ÷ current liabilities | higher |
| Quick ratio | (cash + receivables) ÷ current liabilities | higher |
| Working capital | current assets − current liabilities | higher |
| Liabilities to equity | total liabilities ÷ equity | lower |
| Days sales outstanding | receivables ÷ revenue of the last 3 months × days in those months | lower |
| Days payables outstanding | payables ÷ (cost of sales + operating expenses without payroll and depreciation) of the last 3 months × days | higher |
| Net cash flow | average monthly change in cash over the last 3 months | higher |
| Cash runway | cash ÷ average monthly net cash outflow of the last 3 months, only when cash is falling | higher |

* Percentages and days are rounded half-even to one decimal place, and ratios to two.
* When a KPI cannot be computed, the page says why instead of showing a number, for example "No revenue in the month", "Equity is zero or negative" or "Cash is not falling".
* **DSO and DPO are approximations.** Receivables and payables include GST, while revenue and expenses do not, so the days read somewhat high.
* Each KPI shows:
  * the change from the previous month, coloured by whether it is an improvement;
  * the value in the same month last year;
  * a 13-month history, each month using its own 3-month window.
* **Targets.** A KPI can have a target of "at least" or "at most" a value, with a note. Its status is met, missed, or no value.
* **Revenue by customer.** Posted invoices less credit notes, without tax, over the last 12 months (and for the month on the report). It shows the top 5 with their shares and the rest grouped together. The page warns when one customer is 40% or more of revenue.

## The management report

For the month, the report shows:

* **P&L lines:** revenue, cost of sales, gross profit, operating expenses, operating profit, other income, other expenses, interest, income tax and net income.
* **Columns:** the month, the previous month, the same month a year earlier, the **approved** budget for the month and the variance against it (green when favourable, neutral when equal), the fiscal year to date, and the budget to date.
  * Budget amounts are grouped the same way as actuals.
  * Without an approved budget for the year, the page says so.
* **Cash:** opening, change and closing cash.
* **The KPIs and their change**, and the **top customers** of the month.
* **Commentary:** up to 10,000 characters, saved and audited.

**Finalising** freezes the report:

* **When:** only a month that has ended can be finalised.
* **What is frozen:** a copy of every figure is stored with the commentary. The report then always shows those figures, even when journals are later posted into the month.
* **Later changes:** any line that has changed since is listed above the report, with the reported and current amounts. This makes back-dated postings visible.
* **Permanence:** a final report cannot be edited, reopened or deleted.

## Permissions

| Action | Permission | Roles |
|---|---|---|
| See KPIs and management reports | `reports.read` | all roles except Employee |
| Set or remove targets; write commentary; finalise | `budgets.manage` | Owner, Admin, Accountant |

## Database guards

* `kpi_targets`: one per KPI per organisation. The KPI must be one of the 13 (CHECK).
* `management_reports`:
  * one per organisation and month, with the month on its first day (CHECK);
  * commentary of at most 10,000 characters (CHECK);
  * `FINAL` exactly when a snapshot, a finaliser and a time are set (CHECK).
* A trigger:
  * creates reports only as drafts;
  * keeps each report's organisation and month fixed;
  * refuses any change to, or deletion of, a final report.
* Row-level security applies as on every tenant table. Target changes, commentary and finalising are in the audit trail.

## Not supported yet (do not rely on these)

* **No custom KPIs** or formulas, no drag-and-drop dashboards, no per-role dashboards, and no drill-down from a KPI to the journals behind it. The figures are shown, but they are not links yet.
* **No dimensions** (department, project, location). A KPI covers the whole organisation in its functional currency.
* **No benchmarks** against peers.
* **No alerts** when a target is missed, and no scheduled or emailed reports.
* **No AI-written commentary:** commentary is typed by people.
* **No export** to PDF or Excel other than the browser's print.
* **Budgets:** only an approved budget is compared, with no choice of version.
* **Cash conversion cycle** is not computed, because there is no inventory costing yet.

## Tests

* `packages/accounting-engine/test/kpis.test.ts` (8 tests):
  * grouping by subtype, including accounts without a subtype;
  * P&L lines, and budget amounts grouped the same way;
  * every KPI on a worked example;
  * the reasons given when a KPI has no value;
  * trailing windows and the monthly history;
  * targets, changes in the right direction, and customer concentration.
* `apps/api/test/kpis.e2e.test.ts` (7 tests), against hand-worked postings:
  * every KPI and its components;
  * the previous month, the same month last year and the history;
  * revenue by customer;
  * a month in progress and a month not yet started;
  * targets, including the refused ones, and their audit trail;
  * the management report against the previous month, a year before and the approved budget, with year to date and cash;
  * commentary;
  * finalising, including a refusal while the month is in progress;
  * a late posting listed against the final report;
  * database tampering;
  * tenant isolation.
* `apps/web/e2e/kpis-flow.test.mjs` (2 tests), in the browser:
  * KPI cards and the figures behind one;
  * setting a target and seeing it missed;
  * the report's comparisons;
  * saving commentary;
  * finalising;
  * a late posting flagged on the final report.

The demo data has four targets, a final report for two months ago with commentary, and a draft with commentary for last month. All of it is made up.
