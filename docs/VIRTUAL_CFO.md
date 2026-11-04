# Virtual CFO

The virtual CFO reads the organisation's posted books and gives what a finance director would give: a health score, an analysis of each area, what to do next, worked answers to common questions, and board packs and investor updates.

Every analysis and answer is worked out by rules in code (`packages/accounting-engine/src/cfo.ts`), not by an AI model, and each one shows:

* **source records**: links to the reports it used, and a table of the records behind it where there is one;
* **relevant period**;
* **calculation method**;
* **assumptions**;
* **confidence** (high, medium or low) and why;
* **recommended actions**;
* **required approvals** for each action.

The AI is used in two places only, and never for figures:

* It writes the executive summary of a pack, from that pack's facts. The summary is checked (see below).
* The copilot can call the CFO's answers as tools and explain them.

The virtual CFO never posts, pays, borrows or changes anything. Tests check that no journal is created.

## Page

**Planning → Virtual CFO** (`/orgs/:orgId/cfo`) shows:

* The **health score** out of 100, its grade and how each of its five parts was scored.
* The headline, and **What to do next**: the recommendations from areas that need action, then those to watch. Each has its priority, a link and who approves it.
* **Ask the CFO**: nine questions. The answer opens under the buttons, and the URL keeps it (`?q=PROFIT_CHANGE`). Questions that list customer or vendor records are greyed out for members without `sales.read` or `purchases.read`.
* **Analysis**: one card for each area.
* **Board packs and investor updates**.

A pack (`/orgs/:orgId/cfo/reports/:id`) shows:

* its status, with **Refresh figures**, **Finalise**, **Delete** and **Print**;
* the AI executive summary, with **Write with AI**;
* the commentary;
* the health score, the recommendations and the sections of the pack.

## Health score

The score has five parts of 20 points each. The rules are stated on the page.

| Part | Points |
|---|---|
| Liquidity | 12 if cash is not falling (10 for 12+ months of runway, 6 for 6+, 2 below), plus 8 for a current ratio of 1.5 or more (4 for 1 or more) |
| Profitability | Net margin over the last three months: 20 at 15% or more, 15 at 5%, 10 at break-even, 4 down to −10% |
| Working capital | Days sales outstanding: 20 at 30 days or less, 15 to 45, 10 to 60, 5 to 90; 10 when there is no revenue |
| Growth | Revenue against the same months last year (or the three months before): 20 at +10%, 14 at 0%, 7 down to −10%; 10 without history |
| Solvency | 10 for positive equity, plus 10 for interest cover of 3 or more or no interest (5 for 1.5 or more) |

The grade is Strong at 75 or more, Fair at 50, Weak at 25, and Critical below that.

## Analysis

The analysis uses 24 months of posted figures up to the last complete month, today's balances, the 90-day cash-flow forecast, loan schedules, the compliance calendar, alerts, the approved budget and saved twin scenarios.

| Area | What it works out | Verdict rules |
|---|---|---|
| Liquidity | Cash, current and quick ratios, average monthly change in cash, runway, lowest cash in the 90-day forecast against the minimum balance | Needs action if cash is nil, runway is under 6 months, or the forecast falls below the minimum. Watch if the current ratio is under 1.2 or runway is under 12 months |
| Profitability | Revenue, gross, operating and net profit and margins over three months, against the three months before and the same months last year | Action on a loss. Watch if net margin fell by more than 3 points |
| Working capital | DSO, DPO, days inventory, cash conversion cycle, overdue receivables | Action over 60 days DSO or over 40% overdue. Watch over 45 days, or if DSO rose by more than 10 days |
| Revenue growth | Three months against the three before and last year; 12 months against the 12 before; share of the largest customer | Action on a fall of more than 10%. Watch on any fall, or if one customer is over 40% |
| Costs | Operating expenses against revenue growth; expense lines whose last three months average more than 15% above the six months before (and by more than 1% of monthly revenue) | Action if costs grew more than 10 points faster than revenue. Watch if any line grew |
| Debt | Loans outstanding, principal and interest due in 12 months, interest cover, debt service cover (EBITDA ÷ repayments), liabilities ÷ equity | Action on negative equity, cover under 1.5 or debt service cover under 1. Watch under 3, 1.25, or liabilities over twice equity |
| Capital and expansion | Free cash above a reserve (the larger of three months of fixed costs and the minimum balance), and how many months an expansion adding a fifth to fixed costs could be funded | Watch when there is no free cash |
| Risks | Runway under six months, forecast below the minimum, a loss, negative equity, low interest cover, customer concentration, overdue filings, high-severity alerts | Action on any high risk |
| Planning | Year-to-date variance against the approved budget, scenarios saved, approved and waiting | Watch without an approved budget or when net profit is behind it |

## Questions

| Question | How it is answered |
|---|---|
| Why did profit change last month? | Each revenue and expense account in the last complete month against the month before, by its effect on profit |
| Which clients are most profitable? | Revenue by client over 12 months, with share, change, overdue amount and days late. Costs per client are not in the books, so the answer says it ranks revenue, not profit (low confidence) |
| Which projects are losing money? | Profit by project over the last 12 months (before overheads) |
| How much cash will we need next quarter? | Minimum balance minus the lowest point of the 90-day forecast, in the base and late cases, with the twin's three-month trend |
| What expenses should we investigate? | Expense accounts last month more than 25% above their six-month average, plus duplicate bill, duplicate payment and unusual journal alerts |
| What happens if salaries increase by 10%? | The twin run twice over 12 months, with and without payroll +10% |
| Which vendors are charging more than expected? | Unit price by vendor and item description: last 90 days against the 9 months before, 5% or more higher, with the extra cost |
| What is our current tax exposure? | Tax payable account balances, plus filings and payments overdue or due in 45 days |
| Which invoices are likely to be paid late? | Open invoices: high risk over 30 days overdue or a customer usually more than 30 days late; medium if overdue or usually more than 7 days late |

## Board packs and investor updates

* **Board pack**: every area.
* **Investor update**: growth, profitability, liquidity, capital and debt.

Packs work like this:

* A pack is made for the last complete month. There is one of each kind a month.
* It keeps the assessment as it stood (a snapshot), plus the plain-text facts an AI summary may use.
* While it is a draft:
  * the commentary can be edited;
  * **Refresh figures** re-reads the books, and clears any AI summary because it was written from the old figures;
  * it can be deleted.
* **Finalise** freezes it. A database trigger refuses any change to, or deletion of, a final pack.

## AI executive summary

**Write with AI** goes through the AI control center's guard. The **Virtual CFO** agent is at level 1 (draft recommendations) and has its own switch and monthly token budget. The model gets:

* instructions that every figure must appear in the facts;
* the pack's facts;
* nothing else: no tools and no access to the books.

When the answer comes back, `checkSummaryFigures` lists every number in it that is not in the facts:

* Whole numbers up to 12 are allowed (counts and months).
* Trailing zeros may be dropped (₹4,30,000.00 written as ₹4,30,000).

A summary with any other number is not kept, and the page shows which figures failed. Refusals, cut-off answers, provider errors and the emergency stop are recorded the same way as for the other agents. Tokens add up on the pack, and the call appears in the AI activity log.

## Copilot

The copilot has two more tools, so it can answer these questions in a conversation with the same figures, method and confidence:

* `get_cfo_assessment`
* `get_cfo_answer` (`question` is one of the nine keys)

The tool set version is now 2, so conversations started before this change are closed for new questions.

## Permissions

* Reading the assessment, answers and packs needs `reports.read`.
* Answers that list customers' or vendors' records also need `sales.read` (late invoices, clients) or `purchases.read` (vendor prices).
* Preparing, refreshing, commenting on, summarising, finalising and deleting packs needs the new `cfo.reports` permission (owners, admins and accountants).
* `cfo_reports` is a tenant table with forced row-level security.

Everything is audited: `cfo_report.created`, `.refreshed`, `.commentary_saved`, `.summary_started`, `.summarised`, `.summary_failed`, `.finalised` and `.deleted`.

## API

All routes are under `v1/orgs/:orgId/cfo`.

| Method and path | Purpose |
|---|---|
| `GET assessment` | Health, headline, findings, recommendations, and the questions this member can ask |
| `GET questions/:key` | One worked answer |
| `GET ai` | Whether an AI summary can be written now, and why not |
| `GET reports`, `POST reports` `{ kind: BOARD \| INVESTOR }` | List, and prepare for the last complete month (409 `REPORT_EXISTS` with `details.id`) |
| `GET reports/:id` | The pack |
| `POST reports/:id/refresh` | Re-read the figures of a draft |
| `PUT reports/:id/commentary` `{ commentary }` | Save commentary |
| `POST reports/:id/summary` | Start the AI summary (202; poll the pack until `ai.status` is not `RUNNING`) |
| `POST reports/:id/finalise` | Freeze it |
| `DELETE reports/:id` | Delete a draft |

## Tests

* `packages/accounting-engine/test/cfo.test.ts` (17) covers:
  * the score and its rules;
  * every area's fields and ratios;
  * cost increases;
  * the forecast below the minimum;
  * an empty organisation;
  * all nine questions;
  * the figure check.
* `apps/api/test/cfo.e2e.test.ts` (13) covers:
  * the assessment from real invoices, bills and journals;
  * every question;
  * permissions and tenant isolation;
  * one pack of each kind a month;
  * commentary and refresh;
  * the AI guard (not set up, off, agent off);
  * a summary rejected by the figure check and one kept;
  * finalise, and the database refusing changes;
  * the control center and activity log;
  * the audit trail;
  * the copilot tools;
  * no journals created.
* `apps/web/e2e/cfo-flow.test.mjs` does the whole flow in the browser, against the Anthropic stand-in.

## Not built yet

* **Benchmarking** compares only with the organisation's own history. Peer and industry benchmarks are the benchmarking module.
* **Profit by client** needs costs per client. Today the answer ranks clients by revenue.
* **Questions** are the nine listed above. For anything else, use the copilot, which can combine these answers with the reports.
* **Thresholds** are fixed rules of thumb. They cannot be set per organisation yet.
* **Packs** have no PDF export. Use **Print** to make one.
* **The AI summary** has been tested only against the local stand-in. It needs a live check with a Claude key.
