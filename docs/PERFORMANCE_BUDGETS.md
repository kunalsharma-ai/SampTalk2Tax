# Performance budgets (PERF-014, PERF-015, PERF-021, PERF-002)

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
| Dashboard, trial balance, income statement, balance sheet, receivables ageing and invoice list for an organisation with a year of transactions | PERF-002 | 1,000 ms | `scripts/volume-test.mjs` (CI step "Volume test") |

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

## Large transaction volumes (PERF-002)

`scripts/volume-test.mjs` fills one organisation with a year of posted invoices and bills, then
times the reports people open most, one request at a time, after a warm-up. Eight members of the
organisation post at once while it is seeded, each within the per-person rate limit. Afterwards it
checks the books: the trial balance balances, and the receivables ageing equals what was invoiced.

CI runs it with 2,000 invoices, 400 bills and 200 customers. Run by hand, it defaults to 5,000
invoices and 1,000 bills:

    node scripts/volume-test.mjs --check

Making it pass needed three changes, each with a test in `apps/api/test/large-volumes.e2e.test.ts`:

- **Many people posting into one organisation.** Postings into one organisation meet on its
  counters and its audit chain. MongoDB answers a write conflict at once, so with eight people
  posting, some transactions conflicted 40 times in a row and failed. Now the first run goes
  ahead at once. After a conflict, the retries in one API process for the same organisation take
  turns (`apps/api/src/db/data-client.ts`). In the same run, conflicts fell from up to 40 per
  posting to at most 2, and no posting failed.
- **Reads fetch only what they ask for.** A query that selects a few fields used to read whole
  documents, with every line, and decode every amount. Now MongoDB returns only the selected
  fields and the keys of the relations the query loads. The invoice list and the ageing became
  about twice as fast.
- **Indexes on the shared tables.** The audit trail, usage and error events and security alerts
  hold rows for every organisation, and they had no index on the organisation. Each background
  run that asked where an organisation's audit trail ended scanned the whole trail. These tables
  now have an orgId index, and the audit trail also has indexes by date, by record and by action
  (migration `20270315100000_shared_table_indexes`). The latest event of an organisation is now
  read as one row through the index, not by reading all of its rows.

### Measured (2026-11-25, development container)

| Report | 2,000 invoices, p95 | 5,000 invoices, p95 |
| --- | --- | --- |
| Dashboard | 46 ms | 78 ms |
| Trial balance | 27 ms | 54 ms |
| Income statement | 30 ms | 53 ms |
| Balance sheet | 26 ms | 57 ms |
| Receivables ageing | 226 ms | 491 ms |
| Invoice list | 105 ms | 233 ms |

Before the changes above, the 2,000-invoice run measured 390 ms for the ageing and 225 ms for the
invoice list. Seeding 2,000 invoices and 400 bills took 193 s, and 5,000 and 1,000 took 474 s. In
both runs the trial balance balanced and the receivables equalled what was invoiced.

The receivables ageing grows with the number of open invoices, because it lists every one. At
around 10,000 open invoices it would reach the budget. These are single-machine numbers with one
organisation; they do not measure production with network latency or many large organisations at
once.

## Efficient search (PERF-012)

The header search (Ctrl+K) looks for part of a name, number or reference in customers and
vendors, documents, payments, journal entries and accounts. Such a search cannot narrow an index
to a range, so it used to read every record of the organisation that might match and sort them
all, only to show eight.

Now each searched field has an index that starts with the organisation (migration
`20270316100000_search_indexes`): document and payment numbers and references, journal
references and memos, account names, and the existing contact name and account code indexes.
`apps/api/src/graph/record-search.ts` walks each of those indexes in its own order, newest
numbers first and names A to Z. MongoDB tests the text on the index entries alone and fetches
only the records that match. Each walk stops after one page of matches. For each field there is
one walk for values that start with the text and one for values that contain it, so an exact or
starting match is never crowded out. Results are ranked: the whole value, then values that start
with the text, then values that contain it. The text is always escaped, so `(`, `.` or `*` are
only characters.

`apps/api/test/search.e2e.test.ts` records the database's own profile of a search that matches
all 40 of an organisation's invoices. Every read uses an index, none scans the collection, and
each fetches at most a page of eight records. The same test covers ranking, case, pattern
characters, references, journal memos and numbers, account codes, and other organisations.

The CI volume test times five searches (a term matching every invoice, part of a number, a
customer, a bill reference, and nothing) against the 2,000-invoice organisation. The budget is
`search-at-volume-p95`, 300 ms.

### Measured (2026-11-26, development container)

| Search | 2,000 invoices, p95 | 10,000 invoices, before | 10,000 invoices, after |
| --- | --- | --- | --- |
| Every invoice (`INV`) | 31 ms | 56 ms | 22 ms |
| Part of a number (`012`) | 32 ms | 47 ms | 39 ms |
| A customer | 53 ms | 37 ms | 39 ms |
| A bill reference | 29 ms | 41 ms | 41 ms |
| Nothing matches | 30 ms | 55 ms | 36 ms |

"Before" and "after" are the slowest of five runs. Both ran against the same organisation, and
"before" already had the new indexes, which also help the old queries. At these volumes the
search was already fast. The change matters as an organisation grows: the old search read every
matching record, so its cost grew with the number of matches. The new one fetches at most one
page per field, however many records match. In a separate test on 20,000 records of 2 KB each,
the old query read all 20,000 records in 113 ms. Walking the index read 8 records in 1 ms.
