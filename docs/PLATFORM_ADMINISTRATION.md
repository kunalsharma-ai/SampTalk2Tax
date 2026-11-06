# Platform administration

The people who run Talk2Tax use **Platform administration** (`/admin` in the web app,
`/v1/admin` in the API) to look after organisations, people and announcements. This is the first
M9 slice. Plans, subscriptions, billing, support tickets and usage come in the next slices.

## Who can open it

Each user has an optional **platform role**, kept apart from organisation roles:

| Role | Can |
|---|---|
| `SUPER_ADMIN` | Everything below, and suspend or reinstate organisations, disable or enable people, sign people out, change platform roles, make and withdraw announcements |
| `SUPPORT` | Look up organisations and people, and read announcements; answer support tickets (`platform.support`, also held by `SUPER_ADMIN`). Changes nothing else |

Name the first administrator from the API host. The person must already be registered:

```sh
pnpm --filter @talk2tax/api admin:grant --email you@example.com          # SUPER_ADMIN
pnpm --filter @talk2tax/api admin:grant --email helper@example.com --role SUPPORT
```

After that, super admins change roles in the app under **People**. The platform always keeps at
least one active super admin: the last one cannot step down or be disabled. Nobody can disable
their own account. Every grant and change is recorded in the audit trail as
`platform.role_changed`.

People with a platform role see a **Platform admin** link in the header.

## The boundary: no access to the books (ADMIN-021)

A platform role is **not** membership. Organisation routes (`/v1/orgs/:orgId/...`) still need
the person to be a member of that organisation. An administrator who is not a member gets the
same `404` as anyone else.

The admin views read only an organisation's:

- name, legal name, country, currency and data region;
- creation date and demo flag;
- members (name, email, role);
- suspension status and platform actions.

They never read accounts, journals, documents, contacts, attachments, AI conversations or any
amount. These cross-tenant reads run as the system, inside a transaction, and select only those
columns (`AdminService`).

The one exception is support access that the organisation grants itself (ADMIN-022). It is
read-only, ends after at most 72 hours, can be ended early, and every request made under it
is logged for the organisation to see. See [`SUPPORT.md`](SUPPORT.md).

## Organisations

- **Search.** Find an organisation by name, legal name, the email of any member, or its id. The
  newest 200 matches are shown. Filter by status: all, active or suspended.
- **Suspend.** Give a reason of at least 5 characters. The organisation's members see the
  reason in a banner and can still **read and export** everything. Any request that would change
  something (`POST`, `PUT`, `PATCH`, `DELETE`) is refused with `423 ORG_SUSPENDED`.
- **Reinstate.** An optional note can be added.
- **Audit.** Both actions are written to the organisation's own audit trail
  (`platform.org_suspended`, `platform.org_reinstated`), so its owners can see who acted and why.

## People

- **Search.** Find a person by name or email. Each result shows how many organisations they
  belong to, when they joined, when they were last seen (the latest session use) and how many
  devices they are signed in on.
- **Sign out everywhere.** Ends every session the person has.
- **Disable.** Needs a reason. It ends every session and stops sign-in. Their organisations and
  records are not touched.
- **Enable.** Allows sign-in again.

All of these are audited (`platform.user_disabled`, `platform.user_enabled`,
`platform.user_signed_out`).

## Announcements

An announcement is a message of up to 500 characters, with a tone of information or warning. It
can have a start and an optional end. Every signed-in person sees current announcements at the
top of each page (`GET /v1/announcements`). Super admins can withdraw an announcement early.
Announcements are platform data and are not tied to any organisation.

## API

| Method | Path | Platform permission |
|---|---|---|
| GET | `/v1/admin/overview` | read |
| GET | `/v1/admin/organisations?q=&status=all\|active\|suspended` | read |
| GET | `/v1/admin/organisations/:id` | read |
| POST | `/v1/admin/organisations/:id/suspend` `{ reason }` | manage |
| POST | `/v1/admin/organisations/:id/reinstate` `{ note? }` | manage |
| GET | `/v1/admin/people?q=` | read |
| POST | `/v1/admin/people/:id/disable` `{ reason }`, `/enable`, `/sign-out` | manage |
| PUT | `/v1/admin/people/:id/platform-role` `{ platformRole: SUPER_ADMIN\|SUPPORT\|null }` | manage |
| GET / POST | `/v1/admin/announcements` `{ message, tone, startsAt?, endsAt? }` | read / manage |
| POST | `/v1/admin/announcements/:id/withdraw` | manage |
| GET | `/v1/announcements` | any signed-in person |

`GET /v1/auth/me` now includes `user.platformRole`. Organisations (`GET /v1/orgs`) now include
`suspended: { at, reason } | null`.

Errors:

- `403 FORBIDDEN`: no platform role, or a role without the needed permission.
- `409`: `ALREADY_SUSPENDED`, `NOT_SUSPENDED`, `ALREADY_DISABLED`, `ALREADY_ACTIVE`,
  `LAST_SUPER_ADMIN`, `NOT_YOURSELF`, `USER_DISABLED`, `ALREADY_WITHDRAWN`.
- `422`: `REASON_REQUIRED`, `INVALID_WINDOW`.
- `423 ORG_SUSPENDED`: a change was attempted in a suspended organisation.

## Not built yet

These are the later M9 slices:

- AI and API usage monitoring;
- feature flags;
- maintenance mode;
- infrastructure and error monitoring;
- product analytics.

An administrator in one region sees only that region's organisations and people (see
[`REGIONAL_DEPLOYMENT.md`](REGIONAL_DEPLOYMENT.md)).
