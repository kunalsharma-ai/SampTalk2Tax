# API

Base URL (local): `http://localhost:4000`. Live OpenAPI UI: `/docs`; JSON: `/docs/openapi.json`.

All org routes need `Authorization: Bearer <token>` and membership in the organisation. Money values are decimal **strings**. Dates are `YYYY-MM-DD`.

## Endpoints

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /health` | public | Liveness + DB check |
| `POST /v1/auth/register` | public | Create user, returns token |
| `POST /v1/auth/login` | public | Returns token |
| `GET /v1/auth/me` | auth | Profile and organisations |
| `POST /v1/orgs` | auth | Create organisation (caller becomes OWNER); applies chart template and current fiscal year |
| `GET /v1/orgs` | auth | My organisations |
| `GET /v1/orgs/:orgId` | org.read | Organisation |
| `GET/POST /v1/orgs/:orgId/members` | members.read / members.manage | List / add existing user with role |
| `GET /v1/orgs/:orgId/accounts` | accounts.read | Chart of accounts (`?type=`, `?includeInactive=true`) |
| `GET /v1/orgs/:orgId/accounts/:id` | accounts.read | One account |
| `POST /v1/orgs/:orgId/accounts` | accounts.manage | Create account |
| `PATCH /v1/orgs/:orgId/accounts/:id` | accounts.manage | Update (code/header/deactivate protected when in use) |
| `GET /v1/orgs/:orgId/periods` | periods.read | Periods (`?fiscalYear=`) |
| `POST /v1/orgs/:orgId/periods/fiscal-years` | periods.manage | Create a fiscal year |
| `POST /v1/orgs/:orgId/periods/:id/lock` / `unlock` | periods.lock | Lock / unlock |
| `GET /v1/orgs/:orgId/journals` | journals.read | List (`status`, `from`, `to`, `accountId`, `limit`, `offset`) |
| `GET /v1/orgs/:orgId/journals/:id` | journals.read | Entry with lines |
| `POST /v1/orgs/:orgId/journals` | journals.create (+ journals.post if `post: true`) | Create draft or create-and-post. Optional `Idempotency-Key` header |
| `PUT /v1/orgs/:orgId/journals/:id` | journals.create | Replace a draft |
| `DELETE /v1/orgs/:orgId/journals/:id` | journals.create | Delete a draft |
| `POST /v1/orgs/:orgId/journals/:id/post` | journals.post | Post a draft |
| `POST /v1/orgs/:orgId/journals/:id/reverse` | journals.reverse | Post a reversing entry |
| `GET /v1/orgs/:orgId/reports/trial-balance?asOf=&from=&includeZero=` | reports.read | Trial balance |
| `GET /v1/orgs/:orgId/reports/income-statement?from=&to=` | reports.read | Income statement |
| `GET /v1/orgs/:orgId/reports/balance-sheet?asOf=` | reports.read | Balance sheet |
| `GET /v1/orgs/:orgId/reports/general-ledger?accountId=&from=&to=` | reports.read | Account ledger |
| `GET /v1/orgs/:orgId/audit-events` | audit.read | Audit events (newest first) |
| `GET /v1/orgs/:orgId/audit-events/verify` | audit.read | Recompute the hash chain |

## Example: create and post a journal

```http
POST /v1/orgs/{orgId}/journals
Authorization: Bearer …
Idempotency-Key: inv-2026-0042
Content-Type: application/json

{
  "date": "2026-10-15",
  "memo": "Export invoice INV-0042",
  "post": true,
  "lines": [
    { "accountId": "…AR…",      "debit": "1000.00", "currency": "USD", "exchangeRate": "83.4567" },
    { "accountId": "…Revenue…", "credit": "83456.70" }
  ]
}
```

`201` with the posted entry (`displayNumber: "JE-000042"`, line functional amounts). A retry with the same key and body returns `200` with header `Idempotent-Replay: true`.

## Errors

`{ "error": "<CODE>", "message": "…", ... }`

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_FAILED` (with `issues[]`), `INVALID_RANGE` |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND`, `USER_NOT_FOUND` |
| 409 | `PERIOD_NOT_OPEN`, `ALREADY_POSTED`, `ENTRY_POSTED`, `ALREADY_REVERSED`, `IS_REVERSAL`, `NOT_POSTED`, `ACCOUNT_IN_USE`, `NON_ZERO_BALANCE`, `HAS_CHILDREN`, `CONFLICT`, `FISCAL_YEAR_EXISTS`, `LEDGER_INTEGRITY` |
| 422 | `JOURNAL_INVALID` (with `issues[]`), `NO_FISCAL_PERIOD`, `IDEMPOTENCY_KEY_REUSED`, `INVALID_PARENT`, `INVALID_SUBTYPE`, `WEAK_PASSWORD`, `INVALID_DATE` |
