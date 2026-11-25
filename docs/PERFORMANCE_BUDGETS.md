# Performance budgets (PERF-014, PERF-015, PERF-021)

Talk2Tax's speed targets are written down as budgets in [`perf/budgets.json`](../perf/budgets.json).
Each budget names:

- the feature it backs,
- the percentile and the limit in milliseconds,
- the benchmark that measures it, which runs in CI, and
- the conditions it holds under.

A target counts as met only when its benchmark passes.

## Budgets

| Budget | Feature | Limit (p95) | Benchmark |
| --- | --- | --- | --- |
| Common API reads (dashboard, invoice list, accounts, trial balance, income statement) | PERF-016 | 300 ms | `scripts/load-test.mjs` (CI step "Load test") |
| Posting an invoice under the same load | PERF-017 | 1,000 ms | `scripts/load-test.mjs` |
| Opening the dashboard until balances and the monthly chart show | PERF-015 | 2,000 ms | `apps/web/e2e/dashboard-performance.test.mjs` (browser tests) |
| Dashboard to the receivables ageing it links to, until its rows show | PERF-015 | 2,000 ms | same |
| Back to the dashboard, until its balances show | PERF-015 | 2,000 ms | same |

The test conditions for each budget are in `perf/budgets.json`. In short, the dashboard benchmark
uses:

- production builds of the web app and API, with MongoDB, on the CI runner;
- Chromium at 1440x900 with no throttling;
- one organisation holding 120 posted invoices, 40 posted bills and 20 customers over the current
  fiscal year;
- five timed runs after one warm-up.

Each timing runs from the action until what it shows is on screen.

## Keeping claims honest

`scripts/check-performance-claims.mjs` runs in CI (step "Performance claims"). It fails when:

- a budget is incomplete;
- a benchmark is missing, does not run in CI, or hard-codes its limit instead of reading it from
  `perf/budgets.json`;
- a feature with a budget is marked Implemented or Tested without its benchmark as evidence;
- a PERF feature with a time target in its description is claimed without a budget.

## Measured (2026-11-25, development container, the same conditions)

| Budget | p95 | Samples (ms) |
| --- | --- | --- |
| Open dashboard | 533 ms | 487, 533, 515, 514, 530 |
| Drill down to ageing | 569 ms | 422, 439, 449, 380, 569 |
| Back to dashboard | 198 ms | 198, 105, 106, 123, 100 |

These numbers come from a single machine with one user. They show the budget holds under the
conditions above. They are not a measure of production with real network latency or many
concurrent users; the load test covers concurrency for the API.
