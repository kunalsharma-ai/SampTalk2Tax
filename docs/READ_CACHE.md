# Read cache (PERF-010)

Every request to an organisation used to read the same things from MongoDB before doing any
work: the person's membership, the organisation, its subscription and plan, whether it requires
two-step sign-in, whether the person has it on, and the organisation's access rules. The read
cache keeps those answers in the API process's memory, and MongoDB itself keeps them correct.

## What empties it

`ReadCache` (`packages/document-db/src/read-cache.ts`) depends on no timer. It is emptied by:

- **This server's writes.** The MongoDB driver reports every command the process sends
  (command monitoring). A write to a cached collection empties the entries that depend on it
  when the write succeeds, and again when its transaction commits. That covers every write path,
  including scripts and tests that write straight to the database through the same connection.
- **Other servers' writes.** A change stream on the cached collections empties the same entries
  a few milliseconds after another process commits. In the two-server test, a member removed
  through one server is refused by the other on the next request.
- **Not following.** While the change stream is not running (starting up, or after an error,
  when it reopens after a second), nothing is kept and every read goes to the database.
- **Overlapping reads.** An answer read while a collection it depends on changed is returned
  but not kept.

Reads inside a transaction never use the cache, since they must see the transaction's own
writes. Entries are kept at most five minutes, and at most 10,000 are kept.

## What is cached

| Entry | Collections it depends on | Read by |
| --- | --- | --- |
| A person's membership of an organisation | memberships | Auth guard |
| The organisation (time zone, currency, region, suspension) | organizations | Auth guard |
| Its subscription and plan features | subscriptions, plans | Auth guard |
| Whether it requires two-step sign-in | org_security_settings | Two-step check |
| Whether the person has two-step sign-in on | user_mfa | Two-step check |
| Its active access rules | access_rules | Access-rule check |

The list is `READ_CACHE_COLLECTIONS` in `apps/api/src/common/document-store.service.ts`.
Sessions and users are not cached: signing out and revoking a session go to the database every
time.

Set `READ_CACHE=off` to turn the cache off.

## Measured (2026-11-26, development container)

These are load-test runs with the CI options (`--busy 8`), taken in turn with the cache off and on:

| | Cache off | Cache on |
| --- | --- | --- |
| Common reads p95 | 114 to 134 ms | 86 to 88 ms |
| Busy organisation's reads p95 | 127 to 142 ms | 88 to 90 ms |
| Dashboard p50 | 31 to 42 ms | 17 to 25 ms |
| Posting p95 | 541 to 569 ms | 558 to 636 ms |

Of the guard's lookups, 98% were answered from memory. Reads became about a third faster.
Posting did not: its time goes to the organisation's numbering and audit chain, not to these
lookups.

Tests: `apps/api/test/read-cache.e2e.test.ts`. They cover repeated requests answered from
memory, and changes taking effect on the very next request: a removed member, a role change,
an organisation suspended in the database, and two-step sign-in turned on. They also cover a
member removed through another server, and nothing being cached while the stream is stopped.
