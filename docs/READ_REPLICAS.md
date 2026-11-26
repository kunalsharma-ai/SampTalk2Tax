# Read replicas (PERF-011)

Talk2Tax runs on a MongoDB replica set. With `MONGODB_REPLICA_READS=reports`, report pages read from a secondary member, so heavy reports take load off the primary that every change goes to.

## What reads from a replica

- **Report pages**: every `GET /v1/orgs/:orgId/reports/...` route (trial balance, income statement, balance sheet, cash flow, the tax, payroll, audit and expense reports, visuals, the report studio and the rest under `reports/`). `readsFromReplica` in `apps/api/src/common/replica-reads.interceptor.ts` names them.
- Their reads go with read preference `secondaryPreferred` and `maxStalenessSeconds` = `MONGODB_REPLICA_MAX_STALENESS_SECONDS` (default 120; MongoDB's minimum is 90). A secondary further behind than that is not used; with no usable secondary, the read goes to the primary, so a report always answers.

## What always stays on the primary

- Sign-in, session, membership, plan and permission checks: the replica scope is set by an interceptor, which runs after the guards.
- Everything read inside a transaction, and every write.
- The read cache's loads (PERF-010): a value read from a replica that is behind could otherwise be kept after the change that made it out of date had gone by.
- Every other page.

## Trade-off

A report may be up to the staleness limit behind the books: a journal posted a moment ago may not be in a trial balance opened straight after. Keep `off` where reports must show the very latest posting; the default is `off`.

## Watching it

Platform admin → System health → Database shows how many replica members can answer reads and where report reads go. With `reports` set and no secondary member, the page lists it as a problem (the reads still work, on the primary).

## How it works

`DocumentStore` (packages/document-db) takes `replicaReads: { maxStalenessSeconds }`. `store.fromReplica(fn)` marks fn's reads (find, count, distinct, aggregate) with the read preference through an AsyncLocalStorage scope; `readsFromReplica()` is false inside a transaction.

## Tests

- `packages/document-db/test/store.test.ts` (reads from replicas): reads inside `fromReplica` carry `secondaryPreferred` and the staleness; writes, transactions and reads outside it do not; a one-member set still answers; a staleness under 90 is refused.
- `apps/api/test/read-replicas.e2e.test.ts`: with `MONGODB_REPLICA_READS=reports`, a trial balance reads its data from the replica while the checks before it read from the primary; other pages and writes stay on the primary; System health shows the setting, the members and the problem; the route rule and the config limit.
- `apps/web/e2e/operations-flow.test.mjs`: System health's Database card shows where report reads go.
