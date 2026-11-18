# Cost allocation (GL-024)

Departments are the cost centres (see `FINANCIAL_DIMENSIONS.md`). Cost allocation spreads shared
costs from where they were booked to the departments that use them.

- **Rule**: a name, one or more postable expense accounts, where the cost sits now (one
  department, or costs with no department), and the departments that share it with their
  percentages (at least two, adding up to exactly 100, up to four decimals; the source cannot
  also receive). Rules are switched off, never deleted.
- **Preview**: for a period, each account's net cost in the source (posted entries, closing
  entries left out) and the journal that would move it: a credit on the source for the whole
  amount and a debit on each department for its share. Rounding goes to the largest share, so
  the parts always add up (`packages/accounting-engine/src/cost-allocation.ts`).
- **Run**: posts that journal (source `ALLOCATION`) dated the last day of the period. A rule
  posts once per period (unique index on posted runs); reversing a run posts the reversing
  journal on the same date and frees the period to run again.

## API

All under `/v1/orgs/:orgId/cost-allocations`.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `` (rules, runs, options) | reports.read |
| POST / PUT | `/rules`, `/rules/:ruleId` | accounts.manage |
| GET | `/rules/:ruleId/preview?from&to` | reports.read |
| POST | `/rules/:ruleId/run` `{from,to}` | close.manage and journals.post |
| POST | `/runs/:runId/reverse` | close.manage and journals.post |

Every rule change, run and reversal is audited (`cost_allocation*`).

## Not built

- A cost centre hierarchy (departments are flat).
- Budgets per cost centre (budgets are by account).
- Allocation by a driver that changes each period, such as headcount or usage.

## Tests

- `packages/accounting-engine/test/cost-allocation.test.ts`
- `apps/api/test/cost-allocations.e2e.test.ts`
- `apps/web/e2e/cost-allocations-flow.test.mjs`
