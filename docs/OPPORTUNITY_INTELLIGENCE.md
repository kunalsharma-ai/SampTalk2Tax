# Opportunity intelligence

Opportunity intelligence looks through the organisation's own posted books for profitable growth. It sizes each opportunity from named records and measures it with the [business impact engine](BUSINESS_IMPACT.md), and so with the [digital twin](DIGITAL_TWIN.md). Nothing is posted, sent or committed.

**Planning → Growth opportunities** (`/orgs/:orgId/planning/opportunities`).

## What it looks for

It looks at the last twelve complete months: the nine earlier months and the three most recent ones.

| Opportunity | Found when | Sized as | Becomes |
| --- | --- | --- | --- |
| **Win back lapsed customers** | A customer bought in at least two of the nine earlier months and nothing in the last three | Their sales over the nine months ÷ 9, times the win-back rate (default 25%) | New sales building up over 3 months from month 2, at the business's cost of sales ratio |
| **Sell an existing line to more customers** | A revenue account (line) is bought by at least three customers, and customers who bought anything in the last six months do not buy it. The two largest are shown | The line's average monthly sales per buyer, times the customers without it, times the take-up rate (default 15%) | New sales building up over 4 months from month 2 |
| **Grow the most profitable segment** | At least two departments (or two projects) have sales, and the best margin is positive | The segment's monthly sales times the growth rate (default 10%) | New sales building up over 6 months, carrying the segment's own cost share (costs tagged to it ÷ its sales) |
| **Recover gross margin** | Gross margin in the last three months is at least 2 points below the nine months before | The price rise that restores the earlier margin if costs stay where they are: cost share now ÷ (1 − earlier margin) − 1 | A price change from month 2, with volume unchanged |

Sales are the revenue lines of posted invoices less credit notes, before tax, by customer, month and revenue account. Gross margin comes from the same monthly figures the KPIs and the digital twin use. Segment figures come from the department and project profit report.

## What each opportunity shows

* **The finding**, in words, with the figures it rests on.
* **The evidence**: the customers, lines, segments or periods it rests on (up to ten rows).
* **Extra net profit, extra revenue** (with the change in gross margin) **and cash at the end**, measured over the chosen horizon against carrying on as is.
* **Assumptions**.
* **Confidence**, with the reason:
  * *medium* when several customers or many buyers support it;
  * *low* when only one or two do, when the books have fewer than nine months of sales, or for segment growth, which rests on how costs are tagged.

  Nothing is ever marked high, because take-up is an estimate.

Opportunities are ranked by extra net profit. The summary gives the range, and the total if all were taken. The total does not allow for overlap between them.

**What was checked** lists every kind of opportunity with what was found, or why nothing was. For example: *No sales are tagged to departments or projects.* An empty result is therefore an answer.

## Changing the assumptions

The win-back rate, the take-up rate, the segment growth and the horizon (6, 12, 18 or 24 months) can be changed on the page. **Look again** re-runs everything. Rates must be above 0 and at most 100. Problems are explained in words.

## Taking one forward

**Assess in business impact** saves the opportunity as a [business impact assessment](BUSINESS_IMPACT.md). The assessment takes the title as its name (with "(2)" and so on when the name is taken) and the finding and assumptions as its description. It is opened at once, so the figures can be adjusted, other changes added, and the result sent to the war room as a twin scenario. Saving the assessment is audited there.

## Permissions

| Action | Needs |
| --- | --- |
| See opportunities | `reports.read` and `sales.read`, because opportunities name customers and their sales |
| Take one forward | `scenarios.manage` and `purchases.read`, as for any business impact assessment |

## API

* `GET /v1/orgs/:orgId/opportunities?horizonMonths=&winBackRatePercent=&crossSellRatePercent=&segmentGrowthPercent=` returns the window, settings, opportunities, checks and summary.
* `POST /v1/orgs/:orgId/opportunities/:key/assessment` (with the same query) creates the impact assessment and returns it. Keys are `WIN_BACK`, `MARGIN_RECOVERY`, `CROSS_SELL:<accountId>` and `GROW_SEGMENT:<dimensionValueId>`. When the opportunity is no longer in the books, it answers 404.

## Limits

* The kinds are fixed (four), and the rates are the user's estimates.
* Lines are revenue accounts, not individual products, because invoices are not itemised by product.
* Segment margins only include costs tagged to the department or project.
* Opportunities are measured one at a time; their total ignores overlap (a won-back customer could also be a cross-sell target).
