# Load testing (QA-017, PERF-003)

`scripts/load-test.mjs` puts load on a running API and checks the results against the
performance budgets and the books. It needs nothing beyond Node: no k6 or other load tool.

```sh
node scripts/load-test.mjs --api http://localhost:4000 --orgs 20 --users 2 --rate 4 --seconds 30 --seed 20 --check --out load.json
```

| Option | Default | Meaning |
|---|---|---|
| `--orgs` | 20 | Organisations, each set up from scratch (owner, accountants, a customer) |
| `--users` | 2 | People per organisation, each signed in on their own |
| `--busy` | 0 | One more organisation with this many people working in it at once (PERF-003) |
| `--rate` | 4 | Requests a second per person (the API allows 600 a minute per person) |
| `--seconds` | 30 | How long the load runs |
| `--seed` | 20 | Invoices posted in each organisation before the load starts |
| `--check` | off | Exit non-zero when a budget is missed or the books disagree |

Each person works through the common reads (dashboard, invoice list, chart of accounts, trial
balance, income statement) and posts an invoice every sixth request, all organisations at once.

## Budgets checked

| Budget | Limit | Source |
|---|---|---|
| Common API reads, 95th percentile | under 300 ms | PERF-016 |
| Posting an invoice (journal, numbering, audit, in one transaction), 95th percentile | under 1,000 ms | PERF-017 |
| Failed requests (5xx, or a status the script did not expect) | none | |
| Each organisation's trial balance balances | always | PERF-017 |
| Receivables equal the invoices posted; invoice numbers unique and unbroken | always | PERF-017, PERF-018 |

The report (`--out`) records the test conditions with the results: how many organisations,
people and requests, for how long, against which API. The figures hold for those conditions and
that machine only; they are a measurement, not a promise for other set-ups.

## In CI

The CI job runs it after the browser tests against the API it started, sized for a shared runner:
10 organisations with 2 people each, plus one busy organisation with 8 people (28 people in
all), 3 requests a second, 20 seconds.

## What it found

The first run (20 organisations, 2 people each, 4 requests a second) failed: posting took 5.6 s
at the 95th percentile and 69 of 302 postings failed with MongoDB write conflicts. Every audit
event took its id from one global counter inside its transaction, so writing transactions of all
organisations conflicted on that one document and retried until they gave up. Serial ids are now
taken outside the transaction (`DocumentStore.nextSerial`). They stay unique and increasing,
with a gap where a transaction is abandoned. Order within an organisation still holds, because an
audit append takes the organisation's chain lock first and keeps it until it commits. On the same
machine after the fix: 155 requests a second, no failures, reads 109 ms and posting 576 ms at the
95th percentile.

## Many people in one organisation (PERF-003)

With `--busy`, one organisation has many people working at once. Their postings meet on the
same invoice counter and audit chain, so this is the hardest case for posting. The report shows
the busy organisation's reads and postings separately (`busyOrganisation`). Those must meet the
same budgets, with no failed request, and its books are checked like every other organisation's.

Before PERF-002, eight people posting into one organisation made some postings fail after 40
write conflicts in a row. Retries in a process now take turns per organisation (see
[Performance budgets](PERFORMANCE_BUDGETS.md#large-transaction-volumes-perf-002)).

Measured on the development container with the CI options (2026-11-25): 74 to 83 requests a
second and no failures.

| People in the busy organisation | Its reads p95 | Its posting p95 | All postings p95 |
| --- | --- | --- | --- |
| 5 | 99 to 102 ms | 737 to 816 ms | 604 to 687 ms |
| 6 | 116 to 119 ms | 867 to 1,167 ms | 671 to 932 ms |
| 8 | 111 to 152 ms | 933 to 982 ms | 613 to 707 ms |

The development container is slower than the CI runner: the same load test without the busy
organisation posts at 364 ms p95 in CI and at 571 to 589 ms here. On this machine, posting with 6
or more people in one organisation comes close to the 1,000 ms budget, and one run missed it. A
posting takes about 80 ms on its own, and most of the rest is waiting for the database. Each
request also makes about ten lookups for the signed-in member, the organisation and its plan.
Caching those (PERF-010) is the next way to speed this up.

Not covered yet: soak runs over hours and the web app's own rendering time (PERF-015).
