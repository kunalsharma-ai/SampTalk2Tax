# Operations: system health, errors, feature flags and maintenance

M9 slice 6. For the people who run Talk2Tax, under **Platform admin**. Support staff can read
every screen here; only super admins can change flags, resolve errors or start maintenance.
Every change is kept in the audit trail (global chain; flag settings for one organisation also
in that organisation's own trail).

## Request ids

Every API request gets an id, returned in the `X-Request-Id` header and in every error body as
`requestId`. An incoming `X-Request-Id` of 8 to 64 letters, digits and dashes is kept, so a
proxy's id carries through. When something fails unexpectedly the web app shows the message with
`Reference: <id>`; support pastes that reference into **Errors → Reference a person quoted** to
open the exact occurrence.

## Errors (ADMIN-017)

Every unexpected server error (a 5xx other than 503) is recorded by the API's error filter:

- **Grouped** by the kind of error, the first frame of the application's own code (without line
  numbers, so a rebuild does not split a group) and the route pattern (`/v1/orgs/:id/journals`,
  ids and numbers replaced), so the same problem in every organisation is one group.
- Each **occurrence** keeps the request id, status, method, route pattern (never the query
  string), the organisation and person as ids only, the message and the stack trace.
- A group can be **resolved**; if it happens again it opens again by itself.
- Occurrences are kept **30 days** (removed as new errors arrive); groups and their counts stay.
- Recording never fails the request. The person only ever sees "Unexpected server error" and the
  reference, never the internal message.
- Occurrences are under row-level security like tenant data (they name an organisation); the
  platform screens read them as the system.

Expected refusals (4xx: validation, permissions, limits) are not errors and are not recorded.

## System health (ADMIN-010, ADMIN-011)

**Platform admin → System health**, refreshed every 15 seconds, measured on each request:

| Part | What is shown |
|---|---|
| Overall | Healthy, Needs attention (a slow database, a failing or late runner, unfinished migrations, server errors in the last 15 minutes) or Down (database not answering) |
| Database | Time to answer `SELECT 1`, size, connections in use of the maximum, PostgreSQL version, last migration and any unfinished one |
| API server | Version (and `GIT_SHA` when set), environment, region, uptime, memory, load average |
| Background runners | Workflow runner, alert checks, renewals and reminders: interval, runs, last pass and how long it took, failures, passes skipped for maintenance, and Late when a pass is overdue by two intervals |
| Requests | Last 15 minutes: requests, 4xx, 5xx, p50 and p95 per route pattern, and requests per minute |

Request timings and runner heartbeats are kept **in memory by each API server instance**; with
several instances behind a load balancer each page shows the instance that answered it. Nothing
here is sent to an outside monitoring service.

## Feature flags (ADMIN-007)

Flags are declared in code (`packages/accounting-engine/src/feature-flags.ts`) with a name, what
they switch and a default. Today four modules are behind flags, all on by default:
`benchmarking`, `forecast-lab`, `disaster-simulation`, `opportunities`.

For each flag an administrator can:

- **switch it off** for everyone: the module leaves the menu and the API refuses its routes with
  `403 FEATURE_OFF` (its records stay in place and come back when it is on again);
- **roll it out** to a share of organisations (0 to 100%). Which organisations are in the share is
  decided by a stable hash of the flag and the organisation, so an organisation that has it keeps
  it as the share grows;
- **set it for one organisation**, always on or always off, with a reason. This wins over the
  flag's own setting;
- **go back to the default**.

Settings are read once every 10 seconds per API instance, so a change takes effect within that
(immediately on the instance that made it). The organisation's menu asks
`GET /v1/orgs/:orgId/flags` and shows a flagged item only once it is known to be on.

To put a new module behind a flag: add it to `FEATURE_FLAGS`, add `@RequireFlag('<key>')` to its
controller, and `flag: '<key>'` to its menu item in `apps/web/src/lib/nav.ts`.

## Maintenance (ADMIN-020)

**Platform admin → Maintenance** starts maintenance now or schedules it, with a message and an
optional expected end. At most one window is open at a time.

- **Scheduled**: everyone sees "Planned maintenance from …" at the top of every page, including the
  sign-in page. Nothing is paused.
- **In progress**: every change (any method other than GET, HEAD, OPTIONS) by anyone who is not a
  platform super admin or support person is refused with `503 MAINTENANCE` and `Retry-After` (from
  the expected end). Reading and exporting keep working, as do signing in, refreshing and signing
  out and the person's own account (`/v1/auth/*`), and payment gateway webhooks (so no payment is
  lost). The background runners skip their passes. The banner says changes are paused.
- It lasts **until ended** on that page; the expected end is only shown to people. A scheduled
  window can be cancelled the same way.

`GET /v1/status` (public, no sign-in) returns the open window for the banner; the web app asks
every 30 seconds through `/api/status`.

## API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/status` | public | `{ maintenance: { message, state, startsAt, expectedEndAt } \| null }` |
| GET | `/v1/orgs/:orgId/flags` | org.read | `{ <flag key>: boolean }` for the organisation |
| GET | `/v1/admin/system` | platform.read | System health as above |
| GET | `/v1/admin/errors?status=open\|resolved\|all` | platform.read | Error groups, newest first, with totals |
| GET | `/v1/admin/errors/:id` | platform.read | A group with its latest 25 occurrences |
| GET | `/v1/admin/errors/requests/:requestId` | platform.read | The group behind a quoted reference |
| PUT | `/v1/admin/errors/:id/resolved` | platform.manage | `{ resolved }`: resolve or open again |
| GET | `/v1/admin/flags` | platform.read | Every flag with its setting, overrides and how many organisations have it |
| PUT | `/v1/admin/flags/:key` | platform.manage | `{ enabled, rolloutPercent, note? }` |
| DELETE | `/v1/admin/flags/:key` | platform.manage | Back to the default |
| PUT | `/v1/admin/flags/:key/organisations/:orgId` | platform.manage | `{ enabled, reason }` for one organisation |
| DELETE | `/v1/admin/flags/:key/organisations/:orgId` | platform.manage | Remove that organisation's setting |
| GET | `/v1/admin/maintenance` | platform.read | The last 50 windows |
| POST | `/v1/admin/maintenance` | platform.manage | `{ message, startsAt?, expectedEndAt? }`; `409 MAINTENANCE_ALREADY_OPEN` |
| POST | `/v1/admin/maintenance/:id/end` | platform.manage | End or cancel; `409 MAINTENANCE_ENDED` |

## Tables

`feature_flags` (a row only for a changed flag), `feature_flag_overrides` (forced RLS),
`maintenance_windows` (one open at most, unique partial index), `error_groups`, `error_events`
(forced RLS). See [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md).

## Not built yet

- Errors from the web app's own browser code, and from the background runners (shown on System
  health as failing, not grouped under Errors).
- Metrics across several API instances, history beyond 15 minutes, and alerts to an on-call
  service or chat. A Prometheus or OpenTelemetry export would be the next step.
- Flags for more modules, and flags by plan or country (plans and country modules already gate
  modules on their own).
- Product analytics.
