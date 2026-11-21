# Load testing (QA-017)

`scripts/load-test.mjs` puts load on a running API and checks the results against the
performance budgets and the books. It needs nothing beyond Node: no k6 or other load tool.

```sh
node scripts/load-test.mjs --api http://localhost:4000 --orgs 20 --users 2 --rate 4 --seconds 30 --seed 20 --check --out load.json
```

| Option | Default | Meaning |
|---|---|---|
| `--orgs` | 20 | Organisations, each set up from scratch (owner, accountants, a customer) |
| `--users` | 2 | People per organisation, each signed in on their own |
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
10 organisations, 2 people each, 3 requests a second, 20 seconds.

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

Not covered yet: soak runs over hours, very large single organisations (PERF-002 volumes), and
the web app's own rendering time (PERF-015).
