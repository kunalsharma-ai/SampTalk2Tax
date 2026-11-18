# MongoDB data layer

Talk2Tax stores its data in MongoDB alone. The API is NestJS on Express
(`@nestjs/platform-express`). PostgreSQL and Prisma's query engine are gone; the Prisma schema
stays as the description of the models (see [The data client](#the-data-client)).

This document is the rulebook for the data layer, and the record of how the move was made.

| Step | Moved to MongoDB | Status |
| --- | --- | --- |
| 1 | Data layer, replica set, migrations | Done (#87) |
| 2 | `users`, `auth_sessions`, `login_throttles` | Done (#89) |
| 3 | `organizations`, `memberships`, `invitations` | Done (#90) |
| 4 | `accounts`, `fiscal_periods` | Done (#91) |
| 5 | `journal_entries` (lines inside each entry) | Done (#94) |
| 6 | Sales and purchases: `contacts`, `documents` (lines inside), `payments`, `allocations`, `approval_policies`, `approval_requests`, `attachments`, `expense_claims` (lines inside), `bank_statement_imports`, `bank_statement_lines`, `bank_matches`, `bank_reconciliations` | Writes moved (#98); reads still on the copy |
| 7 | Every other table (166): tax, payroll, planning, CRM, orders, AI, platform, the latest modules | Writes kept in step (this step); rules and reads still in PostgreSQL |
| 8 | Reads and reports as MongoDB queries | Done (#109, #110) |
| 9 | Numbering, locks, and the triggers as guards | Done (#111, #112) |
| 10 | Constraints in the API, MongoDB-only writes and tests, then PostgreSQL, the copies and RLS removed | Done (#113 to #116, and step 10d) |

## Why these choices

| Need | PostgreSQL (before) | MongoDB |
| --- | --- | --- |
| Driver | Prisma | The official `mongodb` driver, behind `@talk2tax/document-db`. Prisma's MongoDB connector cannot store decimals, which would break the decimal-only money rule. |
| Money and quantities | `numeric` columns | `Decimal128`. The application still sees decimal strings ("1250.00"). JavaScript numbers are refused for decimal fields, both by the data layer and by the collection validator. |
| All-or-nothing postings | SQL transactions | Multi-document transactions. MongoDB must run as a replica set (one node is enough). The API refuses to start against a standalone server. |
| Tenant isolation | Forced row-level security | Every tenant document has `orgId`. `ScopedCollection` adds the caller's organisation to every filter, insert, update, delete and aggregation, including each `$lookup`, `$unionWith`, `$graphLookup` and `$facet` that reads a tenant collection. With no organisation in context (and no system bypass), every call is refused. |
| CHECK constraints, NOT NULL | Table definitions | `$jsonSchema` validators with `validationLevel: strict`. |
| Unique constraints | Unique indexes | Unique indexes. A per-tenant unique rule starts with `orgId`. |
| Foreign keys | Composite FKs | Reference checks in services or guards, inside the same transaction. Deletes that cascaded are explicit. |
| Triggers (immutability, guards) | PL/pgSQL triggers | Collection `guards` (`beforeInsert`, `afterUpdate(before, after)`, `beforeDelete`) that run inside the write's transaction. A guard that throws undoes the whole transaction. `appendOnly` collections refuse every update and delete. |
| Sequences, autoincrement | Sequences | `store.nextSequence(name)` and `store.nextTenantSequence(name)`, which are atomic and join the current transaction. |
| Raw SQL reports | `$queryRaw` | Aggregation pipelines through `ScopedCollection.aggregate`. They are scoped the same way as reads. |
| Migrations | `prisma migrate deploy` | Versioned TypeScript migrations (`apps/api/src/db/migrations`), applied in order by `dist/db/migrate.js`. Each one is recorded with a checksum, so editing an applied migration is refused, and a lock stops two processes running migrations at once. |

## Rules for code

1. **Only through the store.** Services get `DocumentStoreService` and call
   `store.collection(def)`. Nothing outside `apps/api/src/db` imports `mongodb` or calls
   `systemDb()`. A test (`document-store.e2e.test.ts`) fails if anything does.
2. **Register collections.** Every collection is defined with `defineCollection` and listed
   in `apps/api/src/db/collections.ts`. An unregistered name is refused, including inside a
   `$lookup`.
3. **Ids.** Documents keep a string UUID in `_id`. The application sees it as `id`, and
   filters use `id`. Aggregation pipelines use MongoDB's own `_id`.
4. **Decimals.** List every money or quantity path in `decimals` (`'lines[].debit'` for
   array elements). Filters on those paths, `$set`, `$inc`, `$push` and inserts convert
   strings to Decimal128 automatically. In hand-written pipeline stages, wrap literals in
   `dec('0.00')`. Aggregation results come back as strings.
5. **Transactions.** Wrap every multi-document change in `store.transaction(async () => …)`.
   Calls inside it, at any depth, join it. The driver retries the callback on transient
   errors, so send emails, webhooks and other side effects only after it returns.
6. **Rules come with their tests.** A rule is a guard, a validator rule, a catalog
   constraint or a service check, and a test exercises it.
7. **Tenant bypass** (`allowSystemAccessOutsideRequests`, `withSystemAccess`) keeps its
   meaning: system work sees every organisation, but an insert must name its `orgId`.

## The data client

The services were written against Prisma's model API (`prisma.invoice.findMany`,
`prisma.$transaction(fn)`), and they still are. `PrismaService` is now only a name and a type:
the object behind it is the data client (`apps/api/src/db/data-client.ts`), which answers that
API from MongoDB. The Prisma schema (`packages/database/prisma/schema.prisma`) stays as the
description of the models: `prisma generate` gives the TypeScript types and the model
description (DMMF) the data client reads. No Prisma query engine, SQL database or connection
string is involved.

* **Reads** (`db/mongo-reads.ts`): `findMany`, `findFirst`, `findUnique`, their `OrThrow`
  forms, `count`, `aggregate` and `groupBy`. Filters keep SQL's NULL rules (`not` and `notIn`
  never match NULL); relation filters become id lists; ordering keeps SQL's NULL placement and
  orders enums by declaration; includes are loaded a query per relation. Rows come back as
  Prisma returned them (Prisma.Decimal, bigint, Uint8Array). A query the client cannot answer is
  refused with the model, operation and reason.
* **Writes** (`db/mirror-writes.ts`, `db/mongo-writes.ts`): the stored record is worked out
  first (defaults, update operators, nested creates and deletes, values as the schema keeps
  them), then checked by the collection's guard, its CHECK constraints, foreign keys and unique
  keys, stored, and read back in the shape the caller asked for. Duplicates answer P2002 and
  missing records P2025, as Prisma did. Deletes apply the foreign keys' ON DELETE actions.
* **Transactions**: `$transaction(fn)` is a MongoDB transaction (`DocumentStore.hold`). Inside
  it, calls run one after another, in the order issued, because MongoDB refuses two operations
  at once in one transaction. A write conflict (two postings meeting on one counter or lock)
  runs the whole callback again after a short random wait, up to 40 times. A write outside a
  transaction runs in one of its own. Batch transactions (`$transaction([...])`) and raw SQL are
  refused.
* **Tenant policies**: what PostgreSQL's row-level security did. Reads see only the current
  organisation (and, for copilot conversations, the current member); with no organisation and
  no system bypass a tenant table shows no rows. A write must belong to the current
  organisation. `withSystemAccess` opens every organisation for system bookkeeping.
* **Tables moved by hand** (people, organisations, the chart, the ledger, sales and purchases,
  banking, expenses) have their own collection definitions in `db/collections`. Services write
  them through the store or `MovedTables` (`db/moved-table.ts`); the data client reads them in
  the model's shape, lines kept inside their parent.
* **Rules**: every PostgreSQL trigger is a guard (`db/guards/rules-*.ts`, named after the
  trigger it replaced), with PostgreSQL's wording; a broken rule answers 409
  `LEDGER_INTEGRITY`. The CHECK constraints, foreign keys and unique indexes are in
  `db/constraints/catalog.json`, evaluated with a small SQL expression evaluator
  (`constraints/sql-expr.ts`, three-valued logic as in SQL). A new rule is added there by hand.
  Unique indexes MongoDB cannot hold itself (partial ones, ones on expressions) are enforced by
  the API under a lock document on the key. A `set_config('t2t.<name>')` switch of the old
  triggers is `allowInTx(name, fn)`.
* **Numbering and locks**: every numbered series takes its next number from `_sequences`
  (`db/counters.ts`) inside the caller's transaction, so a rollback gives the number back.
  `lockRow` and `lockName` (`db/locks.ts`) write a lock document in `_row_locks` inside the
  transaction; a second transaction that takes it conflicts and runs again. Autoincrement
  columns draw from `serial:<table>.<column>`. Work queues (workflow deliveries, CRM webhook
  deliveries) are claimed with conditional updates, and per-organisation runners hold a lease
  (`_leases`).
* **Reports** are aggregations: `lineSums` and `ledgerLines` (`db/ledger-queries.ts`), and
  `withOpen`, `openAsOf` and `disputedIds` (`db/subledger-queries.ts`).

New feature tables need their model in the Prisma schema, the model name in
`db/mirrored-models.ts`, a MongoDB migration creating the collection, and their rules as a guard
and catalog entries.

**Tests** that tamper with a table directly (to check that the data layer refuses what the API
never does) use `sqlWrite` (`test/sql-writes.ts`): the SQL is carried out through the data
layer, the WHERE clause evaluated on each record, and each change made as the API would, so
guards and checks apply.

## Known gaps

* **Locking a period does not wait for postings in flight.** PostgreSQL held the period
  `FOR SHARE` during a posting, so locking it waited. MongoDB has no shared lock: a posting reads
  the period in its snapshot, and a lock that commits in the meantime does not stop it.
* **Between a change made straight on a collection and its audit record** (a sign-up, a
  session) a crash can leave the change without its record. `thenOrUndo` reverses the change
  when the record is refused, but not after a crash.

## Upgrading an installation that ran on PostgreSQL

Releases up to the one with step 10c ran both databases and shipped
`db:copy-to-mongo`. Deploy that release first and run it once (it copies whatever MongoDB
lacks), then deploy this one. From here on PostgreSQL is not read or written; keep a backup of it
until you have checked the data.

## How the move was done

The move went module by module in stacked pull requests (#87 to #116, and this one), with the
whole suite passing after each. Moved modules wrote MongoDB and kept a copy in PostgreSQL for
the modules that had not moved; every PostgreSQL transaction owned a MongoDB transaction so both
committed together; a check after every test run compared the two databases field by field;
reads, then reports, then numbering, locks, triggers and constraints moved into the API; then
PostgreSQL was switched off (`T2T_POSTGRES=off`) and the tests rewritten to run without it.
Step 10d removed PostgreSQL, the copies and the switch.

## Running it locally

```sh
docker compose up -d mongo   # a one-node replica set named rs0
cp .env.example .env         # MONGODB_URL and TEST_MONGODB_URL included
pnpm build
pnpm db:migrate
```

Without Docker, start `mongod --replSet rs0` and run `rs.initiate()` once.

The integration tests apply migrations to `TEST_MONGODB_URL`, whose database name must
contain "test". `packages/document-db` has its own tests, which need a replica set at
`TEST_MONGODB_URL` (default `mongodb://127.0.0.1:27017/?replicaSet=rs0`). They use and
drop a throwaway database.
