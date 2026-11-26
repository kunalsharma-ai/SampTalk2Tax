# AI performance (PERF-020)

Governance → **AI performance** (`/orgs/:orgId/ai-performance`, needs `audit.read`) shows how the AI calls made for an organisation went. It is worked out from the AI decision records every AI call already leaves (see [AI_DECISION_RECORDS.md](AI_DECISION_RECORDS.md)); nothing new is stored.

## What it shows

For the last 7, 30 or 90 days (India time, today included):

- **Totals**: calls, failed calls and the failure rate, the typical (median) time and the time 95 in 100 calls finished within, tokens sent to and written by the model, and answers cut short by the length limit (`stop_reason = max_tokens`).
- **By day**: answered and failed calls stacked, with the 95th percentile time as a line; the same figures in a table under the chart.
- **By assistant**: calls, failures, median, 95th percentile and slowest time, tokens and answers cut short, most calls first.
- **Why calls failed**: failed calls by assistant and the error the model's service gave (for example `RateLimitError`), with the last time it happened.
- **Slowest calls**: the five calls that took longest and whether they were answered.

Percentiles use the nearest-rank method over the calls in the group.

## What it never shows

Only figures are read: the query projects agent, outcome, error name, stop reason, start time, duration and token counts. What the AI was given, what it said and its explanation never leave the database through this page.

## API

`GET /v1/orgs/:orgId/ai-decisions/performance?days=7|30|90` (default 30, anything else 400), permission `audit.read`. The work is done by the pure function `aiPerformance` in `packages/accounting-engine/src/ai-performance.ts`.

## Tests

- `packages/accounting-engine/test/ai-performance.test.ts`: percentiles, grouping, every day in the window.
- `apps/api/test/ai-performance.e2e.test.ts`: real API and database: totals, per agent, failures, 7/30/90-day windows, permission, organisations kept apart, no AI text in the answer.
- `apps/web/e2e/ai-performance-flow.test.mjs`: the bank line assistant runs twice against a local stand-in for the Messages API, one answer and one 429; the page shows both calls, the failure and its reason, the tokens and the chart's table.
