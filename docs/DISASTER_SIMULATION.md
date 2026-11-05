# Financial disaster simulation

Disaster simulation shows how the business would cope with severe but plausible shocks:

* a customer that cannot pay;
* a supplier that fails;
* cash that is frozen, or a credit line that is withdrawn;
* a shutdown;
* a collapse in sales.

Each shock is built from the organisation's own customers, suppliers and cash. It is then played forward from the posted books with the [digital twin](DIGITAL_TWIN.md). Nothing is posted, paid or sent.

**Planning → Disaster simulation** (`/orgs/:orgId/planning/disasters`).

## The shocks

Every shock starts in a chosen month of the projection (month 1 is the current month). Each one becomes ordinary digital-twin changes, so the twin's model applies unchanged:

* lost sales take their cost of sales with them;
* payroll and other running costs carry on;
* receivables and payables follow revenue and costs at the business's own collection and payment days;
* write-offs and recovery costs go through profit.

| Shock | Inputs | Becomes |
| --- | --- | --- |
| **Customer default** | A customer from the books; the share of its balance never paid; whether its future sales are lost or replaced | A bad-debt write-off of that share of what the customer owes now (through profit). If sales are lost, a permanent revenue fall equal to the customer's share of revenue: its average monthly sales (revenue lines of posted invoices less credit notes, before tax, over the baseline months) against the baseline revenue |
| **Supplier failure** | A supplier from the books; months until a replacement delivers; sales lost meanwhile (%); how much more the replacement costs (%) | A revenue fall for the disruption months, then higher cost of sales from the month after. The higher cost is the premium times the supplier's share of cost of sales (its average monthly bills before tax, against the baseline cost of sales) |
| **Liquidity shock** | Cash frozen and for how many months; a credit line withdrawn (repaid at once); extra days customers take to pay, and for how long | Cash-only outflows and, within the period, the release of the frozen cash; longer collection days for those months |
| **Operational disruption** | Sales lost (%) and for how many months; recovery cost; insurance payout and months until it arrives | A revenue fall for those months, the recovery cost through profit, and the payout as income when it arrives within the period |
| **Demand collapse** | Sales lost (%), for how many months, extra days customers take to pay | A revenue fall with longer collection days for those months |

Every input is checked, and problems are explained in words. For example: *Shock 2: Months the cash stays frozen must be a whole number from 1 to 60*. A simulation can hold up to 10 shocks.

## What the simulation shows

* A **verdict**:
  * *gets through*: cash never falls below the minimum balance set under cash-flow settings, or zero when none is set;
  * *below minimum balance*;
  * *cash runs out*, with the month.
* A **summary sentence**. For example: *With these 2 shocks together, cash runs out in Oct 2026, and about INR 120000.00 more is needed to stay at or above the minimum balance. Profit over 3 months is INR 60000.00 lower. The hardest single shock is "Liquidity shock", which on its own leaves cash up to INR 600000.00 lower, in Oct 2026.*
* **Lowest cash** and its month.
* **Most cash lost**: the month where cash is furthest below the same projection with no shock, and by how much. A shock whose effect has passed by the lowest month, such as customers paying late for a while, still shows here.
* **Change in profit** and **cash to raise**, each against no shock.
* A chart of month-end cash: the actual months, then the projection with no shock and with the shocks.
* **Each shock on its own**, with how it was worked out in words. Shocks together can be worse than the sum.
* **Month by month**: revenue, net profit, cash flow and month-end cash, against no shock. The table also lists the twin's assumptions.

### A note on customer defaults and cash

When a defaulting customer also stops buying, the money it owed was, in the baseline, being rolled over: each month it paid old invoices and ran up new ones. Losing both the balance and the future sales therefore costs profit by the full write-off, but costs cash mainly through the margin on the lost sales. When the customer's sales are *replaced* by other customers, the write-off costs cash in full. Both cases follow from the twin's model of receivables and are not special-cased.

## Standard stress tests

The page opens with seven tests built from the organisation's own figures (baseline: the last 6 months; 6, 12, 18 or 24 months ahead), worst first by lowest cash. Each shows its result, lowest cash, most cash lost, change in profit and cash to raise:

1. The largest customer (by monthly sales plus what it owes) defaults and stops buying.
2. The largest supplier (by monthly bills) fails: 25% of sales lost for 2 months, then the replacement costs 10% more.
3. Operations stop for a month.
4. Sales fall 30% for six months, and customers take 15 more days to pay.
5. Customers pay 30 days later for six months.
6. Half of today's cash is frozen for three months.
7. A perfect storm: tests 1 and 4 together.

Tests that do not apply, such as when there are no customers, no suppliers or no cash, are left out. A summary says how many the business gets through without falling below the minimum balance, and names the ones where cash runs out. **Open** starts a simulation from a test, and the recovery planner is linked for when cash runs short.

## Saved simulations

People with `scenarios.manage` can save a simulation with a name. Saved simulations are numbered DS-0001 and so on. Only the shocks are stored: every time a simulation is opened, it is re-run on the latest books. The list shows each saved simulation's result today. If a customer or supplier named in a shock no longer appears in the books, the simulation explains which shock needs changing instead of failing.

**Open as a twin scenario** copies the shocks into a [digital-twin](DIGITAL_TWIN.md) scenario named after the simulation. From there it can go through the [war room](WAR_ROOM.md) for notes and approval, and then into [decision memory](DECISION_MEMORY.md).

## API

| Route | Permission | |
| --- | --- | --- |
| `GET /v1/orgs/:orgId/disasters/options?baselineMonths=&horizonMonths=` | `reports.read` + `sales.read` + `purchases.read` | Kinds of shock, customers with average monthly sales and balance, suppliers with average monthly bills, cash and minimum balance |
| `GET …/disasters/stress-tests?baselineMonths=&horizonMonths=` | same | The standard tests, worst first, with a summary. 422 when there are no posted figures |
| `POST …/disasters/simulate` `{ baselineMonths, horizonMonths, shocks }` | same | Runs shocks without saving. 422 with `details.issues` when a shock does not make sense |
| `GET …/disasters/simulations`, `GET …/simulations/:id` | same | Saved simulations, re-run on the latest books |
| `POST …/simulations`, `PUT …/simulations/:id`, `DELETE …/simulations/:id` | `scenarios.manage` (plus the reading permissions) | Save, change and delete. Names are unique per organisation. Audited as `disaster_simulation.created`, `.updated` and `.deleted` |
| `POST …/simulations/:id/scenario` | `scenarios.manage` | Copies the shocks into a digital-twin scenario. Audited as `disaster_simulation.scenario_created` |

Simulations need the sales and purchases ledgers as well as reports, because shocks name customers and suppliers and use their balances.

## Tests

* `packages/accounting-engine/test/disaster.test.ts` (6) checks every figure by hand: a one-month shutdown, a customer default, a cash freeze with credit withdrawn against a minimum balance, a supplier failure's share-weighted cost rise, shocks together with the hardest named, validation, and the standard stress tests (worst first, and only those that apply).
* `apps/api/test/disasters.e2e.test.ts` (5) covers customers' and suppliers' figures from posted invoices and bills, a simulated default, validation, the stress tests, saving, changing, listing, turning a simulation into a twin scenario, the audit trail, that nothing is posted, permissions and tenant isolation.
* `apps/web/e2e/disaster-simulation-flow.test.mjs` runs the stress tests in the browser, then opens, runs, saves and extends a simulation, shows an input error, opens the simulation as a twin scenario, and deletes it.

## Limitations

* Shocks act on organisation-wide figures, not on departments or projects. Customer and supplier shares are averages over the baseline months.
* A supplier's share is measured against cost of sales only. Bills for running costs from the same supplier are not raised.
* Tax follows the twin: a rate on profit with no relief for losses. Insurance payouts are taxed as income when profitable.
* Nothing is probabilistic: each simulation is one deterministic path, not a distribution of outcomes.
