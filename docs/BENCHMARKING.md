# Benchmarking

Benchmarking shows how an organisation's margins, growth, collection days and payment days compare with similar businesses. It is opt-in, and it is designed so that no participant can see another participant's figures.

**Planning → Benchmarking** (`/orgs/:orgId/benchmarking`).

## What it compares

Ten metrics, worked out from the organisation's posted books for the last complete month (`packages/accounting-engine/src/benchmark.ts`):

| Metric | Formula | Better |
|---|---|---|
| Gross margin | (Revenue − cost of sales) ÷ revenue, last 12 months | Higher |
| Net margin | Net income ÷ (revenue + other income), last 12 months | Higher |
| Revenue growth | Last 12 months against the 12 before (needs 24 months of books) | Higher |
| Operating expense ratio | Operating expenses, payroll and depreciation ÷ revenue, last 12 months | Lower |
| Days sales outstanding | Receivables ÷ revenue of the last 3 months × days | Lower |
| Days payables outstanding | Payables ÷ (cost of sales + operating expenses without payroll and depreciation) of the last 3 months × days | Higher |
| Working capital efficiency | (Receivables + inventory − payables) ÷ revenue of the last 12 months × 365 | Lower |
| Revenue per employee | Revenue of the last 12 months ÷ headcount | Higher |
| Project profitability | Profit before overheads of all projects ÷ their revenue, last 12 months | Higher |
| Cash conversion cycle | DSO + days inventory − DPO | Lower |

Metrics are rounded before they are shared: percentages to one decimal place, and days and money to whole units.

Headcount comes from payroll: the employees who had joined and had not left by the month end. If payroll has no employees, the number entered when joining is used.

An organisation always sees its own metrics, with the reason when one cannot be worked out.

## Taking part

Owners and admins (`org.manage`) decide whether to take part. When joining they choose:

* the industry (11 options);
* the size band (1 to 10, 11 to 50, 51 to 250, or more than 250 people);
* optionally, the headcount;
* which metrics to share.

They must also tick the consent statement, which is shown on the page. The consent wording has a version (`CONSENT_VERSION`). Who agreed, and when, is stored and audited.

Comparison is **give-to-get**: a metric is compared only if the organisation shares it.

## Privacy

* **No identifying data in the pool.** `benchmark_contributions` has no organisation id, no name, no amounts and no records. Each row holds:
  * a random participant key;
  * the peer profile: industry, size band, country and currency;
  * the period;
  * the rounded ratios that were shared.
* **Where the key lives.** The participant key is stored only on the organisation's own consent row. It is replaced every time the organisation joins again.
* **No tenant can read the pool.** Row-level security allows access only to the system (`t2t_rls_bypass()`), and a test checks this. Only aggregates over *other* participants leave the server; an organisation's own contribution is never counted in its own comparison.
* **Aggregation thresholds and suppression of small groups:**
  * fewer than 5 other participants with a value: nothing is shown;
  * 5 to 9: the median only;
  * 10 or more: the median and the quartiles (the middle half).
* **Counts are banded.** The number of participants is shown only as 5 to 9, 10 to 24, or 25 or more.
* **Peer groups.** Each metric uses the narrowest group with enough participants, in this order:
  1. same industry, size band and country;
  2. same industry and size band;
  3. same industry;
  4. all participants.

  The page says which narrower groups were suppressed.
* **Currency.** Revenue per employee is compared only with participants in the same currency.
* **Freshness.** Only contributions from the last 3 months are used. A participant's contribution is updated automatically when its benchmarking page is opened in a new month. Owners and admins can also use **Refresh my figures**.
* **Withdrawing** deletes the contribution at once and forgets the key.

## Synthetic data

* **No invented live data.** The live pool holds only real participants' contributions. No benchmark dataset is invented.
* **Demo organisations are kept apart.** Demo organisations (`is_demo`) contribute to, and are compared with, a separate synthetic pool. The page labels it as synthetic demonstration peers.
* **Filling the synthetic pool.** Use `pnpm --filter @talk2tax/api seed:benchmark-peers` (`SYNTHETIC_PEERS`, default 60). It generates labelled rows from a fixed seed, and refuses to run in production.

## API

All routes are under `v1/orgs/:orgId/benchmarking`.

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /` | reports.read | Own metrics, participation, comparison (when taking part) and the methodology |
| `PUT participation` `{ industry, sizeBand, headcount, metrics, consent: true }` | org.manage | Join, or change what is shared (same key) |
| `POST participation/refresh` | org.manage | Re-read the books and replace the contribution (409 `NOT_PARTICIPATING`) |
| `DELETE participation` | org.manage | Withdraw and delete the contribution (409 `NOT_PARTICIPATING`) |

Audit events:

* `benchmark.opted_in`
* `benchmark.updated` (with before)
* `benchmark.refreshed`
* `benchmark.withdrawn` (with the number of contributions deleted)

## Data

* `benchmark_participations` is a tenant table with forced RLS and one row per organisation. Its checks:
  * a participant has a key and no withdrawal;
  * a withdrawn organisation has no key;
  * headcount is between 1 and 10,000,000;
  * the period format is valid.
* `benchmark_contributions` is the platform pool. Its RLS policy is system only, and it has one row per participant key.

## Tests

* `packages/accounting-engine/test/benchmark.test.ts` (7) covers:
  * all ten metrics;
  * the reasons when a metric cannot be worked out;
  * size bands;
  * the thresholds and banded counts;
  * position for higher-is-better and lower-is-better metrics;
  * peer group fallback and currency;
  * that a single participant's value is never returned.
* `apps/api/test/benchmarking.e2e.test.ts` (9) covers:
  * metrics from real journals;
  * permissions and consent;
  * the pool's contents (no organisation id, only the shared metrics);
  * RLS refusing tenants reads and writes of the pool;
  * suppression, median only, then quartiles;
  * synthetic and stale rows left out;
  * changing what is shared, the automatic update for a new month, and refresh;
  * withdrawal and rejoining under a new key;
  * demo organisations compared with the synthetic pool;
  * the audit trail.
* `apps/web/e2e/benchmarking-flow.test.mjs` does the whole flow in the browser. It sets up five real peer organisations and withdraws them at the end.

## Not built yet

* **No added noise.** The pool does not add statistical noise (differential privacy). Someone watching aggregates change over time could learn something about a participant who joined or left in between. Rounding, banded counts and thresholds limit this, but do not rule it out.
* **No protection against fake participants.** One person running several organisations could add them all. Nothing detects colluding participants yet.
* **No protection from database operators.** Operators with direct database access can link a participant key to its organisation. The pool protects participants from other tenants, not from the operator.
* **No external sources.** There are no industry or public datasets, and no third-party benchmark sources.
* **Fixed categories.** Industries and size bands are a fixed list.
* **No trend.** The comparison is for the latest month only; there is no history of positions over time.
