# MongoDB data layer

Talk2Tax is moving its data from PostgreSQL (Prisma) to MongoDB. The HTTP layer does not
change: the API is NestJS on Express (`@nestjs/platform-express`) and stays that way.

The move goes module by module, in stacked pull requests, in dependency order: what
everything else points at (users, organisations) moves first. MongoDB has no foreign keys
into PostgreSQL, so a moved module works. A module still on PostgreSQL stops working as soon
as something it points at has moved, because its foreign keys (to organisations, for
example) can no longer be satisfied. So each pull request says which test suites pass, and
the whole app runs end to end again only once the last pull request lands. This document
is the rulebook every module follows when it moves.

## Why these choices

| Need | PostgreSQL today | MongoDB |
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
6. **Triggers move with their tests.** When a module moves, each of its PostgreSQL triggers
   becomes a guard, a validator rule or a service check. The tests that exercise the
   trigger move with it and must pass against MongoDB.
7. **Tenant bypass** (`allowSystemAccessOutsideRequests`, `withSystemAccess`) keeps its
   meaning: system work sees every organisation, but an insert must name its `orgId`.

## Running it locally

```sh
docker compose up -d postgres mongo   # mongo is a one-node replica set named rs0
cp .env.example .env                  # MONGODB_URL and TEST_MONGODB_URL included
pnpm build
pnpm --filter @talk2tax/api run db:migrate:mongo
```

Without Docker, start `mongod --replSet rs0` and run `rs.initiate()` once.

The integration tests apply migrations to `TEST_MONGODB_URL`, whose database name must
contain "test". `packages/document-db` has its own tests, which need a replica set at
`TEST_MONGODB_URL` (default `mongodb://127.0.0.1:27017/?replicaSet=rs0`). They use and
drop a throwaway database.

## Order of the move

Each step is one or more stacked pull requests. A step moves its collections, services,
raw SQL and triggers, and its existing tests pass against MongoDB.

1. Foundation: `@talk2tax/document-db`, the replica set, the API wiring and migrations.
2. Identity and onboarding: users, sign-in sessions, lockouts, organisations, members, invitations, the audit trail, and the chart of accounts and fiscal periods that onboarding creates.
3. Ledger: journals and lines, trial balance, statements, general ledger.
4. Sales and purchases: contacts, invoices, bills, credit and debit notes, payments, allocations, banking and reconciliation, attachments, approvals, expenses.
5. Tax: GST, TDS/TCS, e-invoicing, e-way bills, payroll, compliance calendar.
6. Planning and AI: budgets, cash flow, KPIs, alerts, copilot, automations, close, and the M6 to M9 modules.
7. CRM and the latest modules: leads, quotes and orders, contracts, purchase orders.
8. Remove Prisma, PostgreSQL, the RLS policies and the SQL migrations.

A posting writes to several collections at once (an invoice writes a journal), so a step
moves together every collection that one transaction touches.
