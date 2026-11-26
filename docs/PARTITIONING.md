# Database partitioning (PERF-009)

**Decision (2026-11-26): Talk2Tax does not split (shard) its database yet.** One MongoDB replica set carries today's volume with room to spare. What we do instead is keep the database ready to be split by organisation, measure it, and say plainly when splitting becomes worth it. This page records why, what is in place, and how to split when the time comes.

## Why not now

Sharding adds config servers, `mongos` routers, a balancer and chunk migrations. That is more to run, back up and restore (see [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md)), and every cross-organisation job, such as the alert runner or platform reports, becomes a scatter-gather across shards. It pays off only when one replica set can no longer hold the data or keep its working set in memory. We are far from that.

### Measured sizes

The averages below are data plus indexes per document, measured on the local test database (MongoDB 8.0.17, 877 MB, 1.26 million documents, after many full test runs):

| Collection | Documents | Bytes per document |
| --- | ---: | ---: |
| journal_entries | 86,580 | 1,796 |
| documents (invoices, bills, notes) | 75,217 | 1,821 |
| payments | 2,519 | 1,095 |
| allocations | 2,182 | 898 |
| bank_statement_lines | 1,809 | 901 |
| audit_events | 360,155 | 639 |

A busy organisation as the volume test models it (2,000 invoices and 400 bills a year, see [PERFORMANCE_BUDGETS.md](PERFORMANCE_BUDGETS.md)) adds roughly:

- 2,400 documents at 1.8 KB, which is 4.4 MB;
- about 4,800 journal entries at 1.8 KB, which is 8.6 MB;
- about 2,400 payments and 2,400 allocations, which is 4.8 MB;
- about 24,000 audit events (ten per document) at 0.64 KB, which is 15 MB.

That is about **33 MB per busy organisation per year**. At the default review size of 2,048 GB, one replica set holds about **63,000 such organisation-years**. Most organisations are far smaller than this profile.

These are estimates from measured averages, not a load test at that size. Recheck them with the System health card (below) on a real database.

The tests also show that speed holds as organisations multiply. These numbers come from CI:

- 1,500 organisations, with background runners that page through them ([MANY_ORGANISATIONS.md](MANY_ORGANISATIONS.md));
- report pages under their p95 budgets on a year of data ([PERFORMANCE_BUDGETS.md](PERFORMANCE_BUDGETS.md));
- report reads moved to secondaries ([READ_REPLICAS.md](READ_REPLICAS.md));
- several API servers on one database ([HORIZONTAL_SCALING.md](HORIZONTAL_SCALING.md)).

Before sharding, the cheaper steps come first:

1. a bigger primary (memory for the working set);
2. report reads on replicas;
3. more API servers.

## When to review

Platform admin → System health → **Database partitioning** shows:

- the database size against `PARTITIONING_REVIEW_DATABASE_GB` (default 2,048 GB);
- the largest collections against `PARTITIONING_REVIEW_COLLECTION_GB` (default 512 GB);
- for each large collection, whether it could be split by organisation as it is.

The card says **Not needed yet** until a size passes its threshold. After that it says **Review partitioning** and gives the reasons. System health also lists a problem once the whole database passes its threshold. The figures are sizes only, never an organisation's rows.

Other signs that point to a review before the sizes do:

- the working set no longer fits in the primary's memory (page faults, cache eviction);
- write throughput saturates the primary even after scaling it up;
- data residency needs one database to serve several regions. Zone sharding by `orgId` ranges can pin each region's organisations to its own shards, though today `DEPLOYMENT_REGION` runs a database per region instead.

These thresholds are engineering guidelines, not MongoDB limits. Set them for the hardware the replica set runs on.

## Readiness to split by organisation

The shard key would be `{ orgId: 1 }`, or `{ orgId: 1, _id: 1 }` so that one very large organisation can still be spread over several chunks. Every query of a tenant collection already carries `orgId` (ScopedCollection adds it), so each request would go to one shard. Every tenant collection already has an index that starts with `orgId`, which the shard key needs. A migration adds one if a definition leaves it out.

MongoDB lets a sharded collection keep a unique index only if the index starts with the shard key. `shardReadiness` in `packages/document-db/src/sharding.ts` reads every collection definition and puts each one in one of these groups:

| State | Count today | Meaning |
| --- | ---: | --- |
| READY | 193 | Every unique index starts with `orgId`, so it can be split as it is. |
| NEEDS_ORG_PREFIX | 57 | A unique index on ids of the organisation's own rows (for example `{ payRunId, employeeId }` or `lines.id`). Putting `orgId` first changes nothing about what is unique, because ids are never reused across organisations. |
| GLOBAL_LOOKUP | 12 | Looked up without the organisation: portal and feed token hashes, API key hashes, payment gateway references, platform-wide invoice and ticket numbers. These stay in an unsharded collection, or the lookup moves to a small unsharded index collection that maps the token to the organisation. |
| GLOBAL | 27 | Shared collections (users, plans, platform settings, audit_events). They are not split. |

`audit_events` is the largest collection, and it is shared because it also holds platform events. If it ever needs splitting, it is append-only and can be sharded on `{ orgId: 1, _id: 1 }` without any unique index to change.

`perf/partitioning-baseline.json` lists the unique indexes that block splitting today. CI (`apps/api/test/partitioning.e2e.test.ts`) fails when a new unique index would block it. A new tenant collection must lead its unique indexes with `orgId`, for example `{ orgId: 1, number: 1 }`. CI also fails when the baseline lists an index that no longer blocks, so the list only shrinks.

## How to split, when it is justified

1. Change the NEEDS_ORG_PREFIX unique indexes so `orgId` comes first, using one migration per module: create the new index, then drop the old one. Remove each from the baseline.
2. For the GLOBAL_LOOKUP collections, keep them unsharded (they are small), or move the token lookup to an unsharded `*_lookup` collection.
3. Set up config servers and `mongos`, restore a backup into the sharded cluster and rehearse it ([DISASTER_RECOVERY.md](DISASTER_RECOVERY.md)), then `sh.shardCollection('<db>.<name>', { orgId: 1, _id: 1 })`, starting with the largest collections in the card.
4. Point `MONGODB_URL` at the `mongos` routers. Transactions, change streams (the read cache) and the per-organisation runners work through `mongos` unchanged.

## Evidence

- `packages/document-db/test/sharding.test.ts`: the readiness rules and the review advice.
- `apps/api/test/partitioning.e2e.test.ts`: the baseline only shrinks; the endpoint is for the platform team only, carries sizes and no organisation data, and reports "justified" (with a System health problem) once the thresholds are passed.
- `apps/web/e2e/operations-flow.test.mjs`: the System health card shows "Not needed yet", the readiness counts and the ten largest collections.
