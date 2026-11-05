# Regional deployment and data residency

Talk2Tax can run as several independent deployments, one per region (for example India, the
European Union and the United Kingdom), so that each organisation's data stays in the region it
chose. This document covers what is built, how to run a region, and how to move an organisation.

## The model

* **One deployment serves one region.** A deployment is the API, the web app and one PostgreSQL
  database. Its region is `DEPLOYMENT_REGION` (a code such as `in-mumbai`) and its readable name
  is `DEPLOYMENT_REGION_NAME` (such as `India (Mumbai)`). Regions share nothing: no database, no
  cache, no queue. Backups are taken and kept per region.
* **Every organisation lives in one region.** `organizations.data_region` is set to the
  deployment's region when the organisation is created and recorded in its `organization.created`
  audit event. Its books, documents, attachments, audit trail and AI activity are stored in that
  region's database only.
* **Only the home region serves an organisation.** Every organisation route checks the region
  after membership. A copy of an organisation found in another region's database (a restored
  backup, a database copied between regions, a move in progress) is refused with HTTP `421
  WRONG_REGION`, for reads and writes alike, so the books are never changed in two places. The
  error carries the home region's code, name and web address. Non-members still get `404` first,
  so organisation ids cannot be probed through this check.
* **People see where their data is.** Onboarding says where a new organisation's data will be
  stored. Account → *Where your data is kept* shows the organisation's region and the regions the
  service runs in. An organisation that lives elsewhere appears in the organisation switcher with
  its region's name and opens as a panel that links to its region's app; nothing about it is read.

## Running a region

| Variable | Notes |
|---|---|
| `DEPLOYMENT_REGION` | 2-32 lowercase letters, digits or dashes. Default `local`. Never change it for a running region: organisations are tagged with it |
| `DEPLOYMENT_REGION_NAME` | The name people read. Default `Local server` |
| `REGION_DIRECTORY` | JSON of the other regions: `{"eu-frankfurt":{"name":"European Union (Frankfurt)","appUrl":"https://eu.talk2tax.example"}}`. Used to point people to an organisation's home and to list regions. Checked at start: a malformed directory stops the API |

`GET /v1/region` (public) returns the region, its name and the directory. `GET /health` includes
`region`, so a load balancer or monitor can check each deployment answers for the region it should.

Each region's web app sets `T2T_API_URL` to its own region's API. DNS (for example
`in.talk2tax.example`, `eu.talk2tax.example`) and the choice of cloud region are infrastructure
decisions outside this repository.

**Organisations from before regions.** The migration adds `data_region` empty. The first API
that starts on a database tags every untagged organisation with its region (logged at start). Once
set, a region can be changed (a move) but never cleared (database trigger), and it must match
`^[a-z0-9-]{2,32}$` (database check).

## Moving an organisation to another region

A move is an operator step, run on the API host of the region the organisation lives in now:

```sh
pnpm --filter @talk2tax/api region:move --org <organisation id> --to eu-frankfurt --reason "Customer asked for EU hosting"
```

1. The command sets the organisation's region to the new one and writes an
   `organization.region_moved` audit event (from, to, reason). From that moment this region
   refuses the organisation and points people to the new region, so no further changes are made
   here.
2. Copy the organisation's rows (every table with its `org_id`, plus its audit events) from this
   database to the new region's database, for example with `pg_dump` filtered by `org_id`, and
   restore them there. The copied organisation already carries the new region, so the new region
   serves it.
3. Check the books in the new region (trial balance, audit chain verification), then delete the
   organisation's rows from the old region when your retention policy allows.

The target region must be listed in `REGION_DIRECTORY`. Only the region an organisation lives in
can hand it on. Running the command with `--to` set to this region's own code undoes a move that
was not completed (the copy was not made); it is audited the same way.

## Not built

* No automated copy between regions: step 2 above is a manual database task, and there is no
  in-app request flow for a move (it is an operator step until the M9 super admin console).
* Sign-in accounts are per region: a person with organisations in two regions signs in to each
  region separately. There is no global account directory.
* No cloud infrastructure is provisioned by this repository: regions, DNS, TLS and backups are set
  up by whoever deploys it. The registry marks PERF-007 *Implemented*, not *Production ready*,
  until a second region runs.
