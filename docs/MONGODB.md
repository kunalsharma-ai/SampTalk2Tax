# MongoDB data layer

Talk2Tax is moving its data from PostgreSQL (Prisma) to MongoDB. The HTTP layer does not
change: the API is NestJS on Express (`@nestjs/platform-express`) and stays that way.

The move goes module by module, in stacked pull requests, in dependency order: what
everything else points at (people, organisations) moves first. The whole test suite
passes after every step, because of the bridge described under
[While both databases run](#while-both-databases-run). This document is the rulebook every
module follows when it moves.

| Step | Moved to MongoDB | Status |
| --- | --- | --- |
| 1 | Data layer, replica set, migrations | Done (#87) |
| 2 | `users`, `auth_sessions`, `login_throttles` | Done (#89) |
| 3 | `organizations`, `memberships`, `invitations` | Done (#90) |
| 4 | `accounts`, `fiscal_periods` | Done (#91) |
| 5 | `journal_entries` (lines inside each entry) | Done (#94) |
| 6 | Sales and purchases: `contacts`, `documents` (lines inside), `payments`, `allocations`, `approval_policies`, `approval_requests`, `attachments`, `expense_claims` (lines inside), `bank_statement_imports`, `bank_statement_lines`, `bank_matches`, `bank_reconciliations` | Writes moved (#98); reads still on the copy |
| 7 | Every other table (166): tax, payroll, planning, CRM, orders, AI, platform, the latest modules | Writes kept in step (this step); rules and reads still in PostgreSQL |
| 8 | Reads and reports as MongoDB queries; Prisma, PostgreSQL, RLS and the copies removed | In progress: reads of the step-7 tables come from MongoDB |

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

## While both databases run

Modules still on PostgreSQL point at moved records with foreign keys (for example
`memberships.user_id`) and read them in joins. So, until the last step:

* **MongoDB is the record** for a moved collection. Only the moved module writes it.
* **A copy stays in PostgreSQL.** Right after its MongoDB transaction commits, the moved
  module copies the rows it changed into their old table (`PostgresMirrorService`). The
  copy is made from what MongoDB now holds, never from the request. Unmoved modules keep
  reading the copy, unchanged.
* **The audit trail stays in PostgreSQL** until the last step, because every unmoved module
  appends to it inside its own transactions. A moved module appends its audit events right
  after its MongoDB change commits.
* **If the PostgreSQL half fails**, `thenInPostgres` undoes the MongoDB half (for example, a
  new sign-up whose audit record cannot be written is removed again). Between the two
  commits a crash could still leave the copy behind. The copy is rewritten on the record's
  next change, and the copying tool below repairs it.

**One transaction across both databases.** Every PostgreSQL transaction owns a MongoDB
transaction (`createTenantAwarePrisma`, `DocumentStore.hold`). MongoDB work done inside the
callback joins it and commits right after PostgreSQL commits; if PostgreSQL fails, it is
abandoned. A MongoDB write conflict runs the whole callback again. So a module that has not
moved (an invoice posting) can post a journal to MongoDB inside its own PostgreSQL transaction,
and both stand or fall together. Two rules follow:

* Inside a transaction, run MongoDB operations one after another, never with `Promise.all`:
  MongoDB runs one operation at a time per transaction.
* Do not open a second `$transaction` inside one to set something up for the outer one: the
  outer MongoDB snapshot would not see it. Do the set-up in the outer transaction.

If MongoDB fails to commit after PostgreSQL did (a crash in between), PostgreSQL holds a change
MongoDB lacks; it is logged, and `db:copy-to-mongo` copies it.

**The ledger.** Journal entries are MongoDB documents with their lines inside. Each posting
is copied, with the same line ids, into the PostgreSQL transaction that made it, where
documents, bank matches and reports still point at it. Entry numbers still come from
PostgreSQL's `org_counters` row, which makes concurrent postings take turns. The triggers
became guards: posted entries are immutable and cannot be deleted, posted entries balance and
match their totals, line amounts are one-sided and non-negative, the period must be open and
contain the date, and accounts must be postable and active. The department and project check
stays on the PostgreSQL copy until dimensions move.

**Writes from modules that have not moved.** GST, payroll, TDS/TCS, bad debts and expense
claims set up their own accounts inside their PostgreSQL transactions. They do it through
`ChartService`, which writes MongoDB and copies the account into the caller's transaction. If
that transaction rolls back, the account stays in MongoDB without a copy; the next set-up
finds it by code and copies it, and the account is audited as created in the transaction that
first copies it.

**Locks that wait for postings.** Locking a period must wait for postings in progress, which
still hold the period's PostgreSQL copy `FOR SHARE`. So locking runs in a PostgreSQL
transaction that takes the copy `FOR UPDATE`, changes MongoDB inside it, and reverses that
change if the transaction fails (`postgresWithMongo`).

**Nested system access.** `withSystemAccess` restores whatever the transaction had before it,
so a mirror copy made inside system work leaves the outer bypass on. Audit rows for routes
without an organisation in their path (accepting an invitation) point the transaction at the
organisation with `useOrgInTx` first.

**Moving writes before reads.** From step 6, a module's writes move first and its reads
follow in step 8, because about 1,200 Prisma calls and 200 SQL reports read these tables.
`MovedTables` (`apps/api/src/db/moved-table.ts`) writes the record to MongoDB, where the
guards check it, then copies what MongoDB now holds into the caller's PostgreSQL transaction
and returns that row, so callers keep their types. A document's lines (and an expense claim's)
are rewritten in the copy only when the set changed, since they change only in drafts. The
copy is updated or inserted, never upserted: PostgreSQL runs BEFORE INSERT triggers for
`INSERT ... ON CONFLICT` even when the row exists. Row locks (`FOR UPDATE`) are still taken on
the copy, so concurrent changes to one record take turns.

**Rules that span records.** Each guard checks what the record itself can see in MongoDB:
document totals, GST and withholding rules, immutability once posted, allocations within the
source's and target's totals, approvals before a covered document posts, statement lines
whose matches add up to the amount. The PostgreSQL copy still runs its own triggers too, so
checks against tables that have not moved yet (withholding deposits, e-invoices, e-way bills,
purchase orders, bad-debt write-offs, dimensions) stay there until those tables move.

**Approvals and draft changes.** The trigger that cancelled a draft's approval when the draft
changed now runs in `DocumentsService` before the draft is saved, so the copy's trigger finds
nothing left to cancel. Deleting a draft clears `documentId` on its requests first, as the
copy's foreign key did.

**Writes kept in step (step 7).** The remaining 166 tables (`MIRRORED_MODEL_NAMES` in
`apps/api/src/db/mirrored-models.ts`) are not moved by hand. Their Prisma delegates are
wrapped (`apps/api/src/db/mirror-writes.ts`): the PostgreSQL write runs as before, with its
triggers and constraints, then the rows it left are read back in full and written to MongoDB
in the same held transaction. Collections come from the Prisma schema: table name, decimals,
unique keys (partial where a column is nullable) and a type validator. Nested writes are
synced by their foreign key. Deletes apply to MongoDB what PostgreSQL's foreign keys do
(`ON DELETE CASCADE` and `SET NULL`), read from the PostgreSQL catalog because many keys were
written by hand in SQL; deletes of hand-moved records (draft documents, draft journals) do the
same through `mirrorParentDeleted`. Rows written by raw SQL or by triggers are synced with
`mirrorRows` after the statement. A new feature table needs only its model name added to that
list and a migration creating its collection. The rules stay in the PostgreSQL triggers until
step 8 turns them into guards, together with the reads.

**Checking they agree.** After every test run, `test/mirror-check.ts` compares each mirrored
table's rows from the organisations made in that run with MongoDB, field by field, and fails
the run with the list in `apps/api/mirror-differences.txt`. Tests that write PostgreSQL
directly (to simulate a change made past the API) sync the rows with `mirrorRows` afterwards.

**Reads (step 8).** Prisma reads of the step-7 tables (`findMany`, `findFirst`,
`findUnique`, their `OrThrow` forms, `count`) are answered from MongoDB
(`apps/api/src/db/mongo-reads.ts`). Filters become MongoDB filters, keeping PostgreSQL's NULL
rules (`not` and `notIn` never match NULL); relation filters through mirrored tables become id
lists; ordering keeps PostgreSQL's NULL placement and orders enums by declaration; includes of
mirrored relations are loaded a query per relation. Rows come back as Prisma returns them
(Prisma.Decimal, bigint, Uint8Array). A query that cannot be translated yet (a relation to a
table moved by hand, `_count`, `distinct`) still reads PostgreSQL; run the tests with
`READ_FALLBACKS_FILE=path` to list them. Set `MONGO_READS=off` to read PostgreSQL again.

* A transaction's MongoDB work runs one call at a time, because MongoDB refuses two
  operations at once in one transaction and PostgreSQL code often reads with `Promise.all`.
* `withSystemAccess` also opens the tenant context to every organisation, as the PostgreSQL
  bypass does.
* Raw `INSERT`, `UPDATE` and `DELETE` statements on mirrored tables bring MongoDB in step by
  themselves: rows the transaction wrote are found by `xmin`, deleted ones by comparing ids.

**Existing data.** An installation with data from before a step runs
`pnpm --filter @talk2tax/api run db:copy-to-mongo` once after deploying it. That copies the
moved tables' rows into MongoDB and leaves records already there alone, so it is safe to
run again.

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
