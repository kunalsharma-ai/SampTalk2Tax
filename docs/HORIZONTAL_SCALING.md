# Horizontal scaling (PERF-008)

Talk2Tax's API can run as several identical servers behind a load balancer, all on one MongoDB replica set. Any server can answer any request.

## What is shared, and how

| What | How it holds across servers |
| --- | --- |
| Sign-in | Access tokens are signed with `JWT_SECRET`; sessions, refresh tokens, two-step codes and login lockout are in the database. Every server needs the same `JWT_SECRET` and `INTEGRATIONS_ENCRYPTION_KEY`. |
| Rate limits | With `RATE_LIMIT_STORE=database`, each request is counted in one shared one-minute window per person or address (`_rate_windows`, an atomic `findOneAndUpdate` with upsert; old windows removed by a TTL index). With `memory` (the default) each server counts on its own, so N servers allow N times the limit. If the database cannot be reached, a server counts on its own rather than turning everyone away. |
| Background work | Runners take each job with a lease in the database (`_leases`, conditional updates), so a job runs once whichever servers are up, and a server that stops loses its lease when it runs out (workflows, bank line runs, bill reading, scheduled reports and the rest). |
| Read cache | Each server's cache is kept correct by MongoDB change streams (PERF-010), so a change made on one server is seen by the others. |
| Files | Stored in the database (encrypted), not on a server's disk. |
| AI lanes | Per server (PERF-005): the total across servers is the per-server limit times the number of servers. |
| Request timings and runner heartbeats | Per server: System health shows those of the server that answers. |

## Running servers

Each server writes its row in `api_instances` when it starts and every `API_INSTANCE_HEARTBEAT_SECONDS` (default 30), and removes it when it stops. A server not seen for three heartbeats is not listed; a row left by a server that died is removed by the database after a day.

Platform admin → System health → **API servers** lists every running server: host and process, version and commit, region, how it counts rate limits, when it started and was last seen, with the one answering marked. The page lists a problem when:

- more than one server is running and any of them counts rate limits on its own (set `RATE_LIMIT_STORE=database` on every server);
- the servers run different versions (expected during a rolling deploy, a problem after it).

## Shutting down

The database connection is closed last, after every service has finished its shutdown work, so a server can remove its row and hand back leases as it stops.

## Tests

- `packages/document-db/test/store.test.ts` (shared rate windows): two stores count in one window; a new window starts again; the TTL date.
- `apps/api/test/horizontal-scaling.e2e.test.ts`: two API servers on one database: a person signed in on one is signed in on the other; six requests pass between them and the seventh is refused with 429 on either; System health lists both and marks the one answering; a third server counting alone raises the problem; a server that stops removes itself.
- `apps/web/e2e/operations-flow.test.mjs`: System health lists the server answering.
- `apps/api/test/workflow-recovery.e2e.test.ts` (QA-016): background work moves to another server when one stops.
