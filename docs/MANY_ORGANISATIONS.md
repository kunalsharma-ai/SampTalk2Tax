# Thousands of organisations (PERF-001)

Every organisation's records live in shared collections, each document carrying its `orgId`, and every query is limited to one organisation by the data layer (see MONGODB.md). What has to hold as organisations grow from tens to thousands:

## Each organisation's own pages

Every organisation collection has an index that starts with `orgId`, so a page reads that organisation's records and never walks the others'. `apps/api/test/many-organisations.e2e.test.ts` checks this for every collection; the one collection that lacked it, `report_schedules`, now has `{ orgId, name }` (migration 20270319100000).

## Background work that visits every organisation

- **Alert checks** take organisations in turn from `org_rotations` (one row per job and organisation, with when it is next due; `OrgRotationService`). A pass reads the organisations that are due by index, at most 200 (`ALERTS_RUNNER_LOOK`), claims each with a conditional update (so two servers never take the same one), checks at most 20 with books, and sets when each is next due: an hour after its last check, or an hour on for an organisation with nothing posted yet. Before, every pass read every organisation and grouped every past alert scan, and looked again at every organisation without books. A pass with nothing due now costs a few queries whatever the number of organisations. New organisations join the rotation (due at once) and removed ones leave it when the counts differ.
- **Scheduled reports** read only schedules whose date has come somewhere in the world (today 14 hours ahead of UTC; each organisation's own today then decides), by index, 500 at a time. Before, every active schedule was read on every pass, at most 5,000, so schedules beyond that never ran.
- **Month-end close start** reads the organisations that asked for it 500 at a time, with no upper limit (before, at most 10,000).

## Read cache after a database drop

Found while testing on a database of its own: when a database is dropped, MongoDB ends the read cache's change stream with an "invalidate" event, after which the stream answers at once with nothing. The cache followed it in a tight loop at full processor use. It now opens a new stream when the stream is invalidated or closed (`packages/document-db/src/read-cache.ts`; tested in `packages/document-db/test/store.test.ts`).

## Tests

- `apps/api/test/many-organisations.e2e.test.ts`, on a database of its own: 1,500 organisations, one with books. Every organisation is visited within `ceil(1500 / 200)` passes and only the one with books is checked; a pass with nothing due costs at most 4 queries; a new organisation is taken in at once; an hour later every organisation is due again and the one with books is checked again. Every organisation collection has an `orgId`-first index.
- `apps/api/test/continuous-alerts.e2e.test.ts`, `report-schedules.e2e.test.ts`, `close-auto-start.e2e.test.ts`: the jobs themselves.
