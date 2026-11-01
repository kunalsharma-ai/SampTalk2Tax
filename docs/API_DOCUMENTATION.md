# API

Base URL (local): `http://localhost:4000`. Live OpenAPI UI: `/docs`; JSON: `/docs/openapi.json`.

All org routes need `Authorization: Bearer <access token>` and membership in the organisation. Access tokens last 15 minutes (`JWT_TTL_SECONDS`); renew them with `POST /v1/auth/refresh`. Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. Money values are decimal **strings**. Dates are `YYYY-MM-DD`.

## Endpoints

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /health` | public | Liveness + DB check |
| `POST /v1/auth/register` | public | Create user and sign in: `accessToken`, `expiresIn`, `refreshToken`, `sessionId`, `sessionExpiresAt` |
| `POST /v1/auth/login` | public | Sign in (same response). 5 failures for one email lock it for 15 min (429) |
| `POST /v1/auth/refresh` | public | `{ refreshToken }` → new access token and a new refresh token. Inside the 30 s grace window `refreshToken` is `null` (keep the one you have); an older token ends the session |
| `POST /v1/auth/logout` | public | `{ refreshToken }` → ends that session. Always 204 |
| `GET /v1/auth/me` | auth | Profile and organisations |
| `GET /v1/auth/sessions` | auth | My live sessions (browser, address, created, last active, ends by, `current`) |
| `DELETE /v1/auth/sessions/current` | auth | Sign out this session |
| `DELETE /v1/auth/sessions/:id` | auth | Sign out one of my sessions (another user's id → 404) |
| `POST /v1/auth/sessions/revoke-others` | auth | Sign out every other session → `{ signedOut }` |
| `PUT /v1/auth/password` | auth | `{ currentPassword, newPassword }` → changes it and signs out other sessions → `{ otherSessionsSignedOut }` |
| `POST /v1/orgs` | auth | Create organisation (caller becomes OWNER); applies chart template and current fiscal year |
| `GET /v1/orgs` | auth | My organisations |
| `GET /v1/orgs/:orgId` | org.read | Organisation |
| `GET/POST /v1/orgs/:orgId/members` | members.read / members.manage | List / add existing user with role |
| `PUT /v1/orgs/:orgId/members/:userId` | members.manage | `{ role }`: change a role (only to and from roles the caller may grant; 409 `LAST_OWNER`) |
| `DELETE /v1/orgs/:orgId/members/:userId` | members.manage | Remove a member (409 `LAST_OWNER`) |
| `GET /v1/orgs/:orgId/invitations` | members.read | Invitations with status PENDING / EXPIRED / ACCEPTED / REVOKED |
| `POST /v1/orgs/:orgId/invitations` | members.manage | `{ email, role }` → `{ invitation, token }`. The token is returned once; the link is `/invite/<token>`. 409 `ALREADY_MEMBER`, `INVITE_EXISTS` |
| `POST /v1/orgs/:orgId/invitations/:id/renew` · `/revoke` | members.manage | New link and 7 more days (old link stops working) / revoke |
| `GET /v1/invitations/:token` | auth | Preview: organisation, role, inviter, status, `forYou`, `alreadyMember` |
| `POST /v1/invitations/:token/accept` | auth | Join with the invited role. Only for the invited email (403 `INVITE_OTHER_EMAIL`); 410 `INVITE_EXPIRED` / `INVITE_REVOKED` / `INVITE_ACCEPTED` |
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
| `GET /v1/orgs/:orgId/contacts?role=customer\|vendor&q=&includeInactive=` | contacts.read | Customers / vendors with outstanding, overdue and unapplied balances |
| `GET /v1/orgs/:orgId/contacts/:id` | contacts.read | One contact with balances |
| `GET /v1/orgs/:orgId/contacts/:id/statement?ledger=SALES\|PURCHASES&from=&to=` | contacts.read | Statement with opening balance and running balance |
| `POST` / `PATCH /v1/orgs/:orgId/contacts[/:id]` | contacts.manage | Create / update (role removal blocked once used) |
| `GET` / `POST` / `PATCH /v1/orgs/:orgId/tax-rates[/:id]` | accounts.read / accounts.manage | Tenant tax rates (rate immutable after creation) |
| `GET /v1/orgs/:orgId/{sales\|purchases}/documents?kind=&view=all\|draft\|open\|overdue\|paid\|void&contactId=` | sales.read / purchases.read | Invoices and credit notes, or bills and vendor credits |
| `GET /v1/orgs/:orgId/{sales\|purchases}/documents/:id` | …read | Document with lines, allocations, amount due |
| `POST /v1/orgs/:orgId/{sales\|purchases}/documents` | …manage (+ journals.post if `post: true`) | Create a draft, or create and post. `overrideCreditLimit` is audited |
| `PUT` / `DELETE …/documents/:id` | …manage | Replace / delete a draft |
| `POST …/documents/:id/post` | …read + journals.post | Post a draft (so an APPROVER can approve an accountant's draft) |
| `POST …/documents/:id/void` | …manage + journals.reverse | Void with a reason; posts an exact reversal. Refused while allocations exist |
| `POST …/documents/:id/apply-credit` | …manage | Apply a credit note / vendor credit to this invoice / bill |
| `GET` / `POST …/payments` | …read / …manage | Receipts (sales) or payments (purchases) with optional allocations. Optional `Idempotency-Key` header |
| `POST …/payments/:id/allocate`, `…/payments/:id/void` | …manage | Allocate unapplied money; void a payment |
| `POST …/allocations/:id/remove` | …manage | Remove an allocation (kept as history) |
| `GET …/ageing?asOf=` | …read | Ageing buckets per contact, reconciled to the control-account balance |
| `GET /v1/orgs/:orgId/banking/accounts` | banking.read | Bank and cash accounts with ledger balance, lines to review, last reconciliation |
| `POST /v1/orgs/:orgId/banking/accounts/:id/imports` | banking.manage | CSV statement (`csv` text + column `mapping`). `dryRun: true` previews and flags lines imported before; otherwise stores new lines |
| `GET …/banking/accounts/:id/imports` | banking.read | Import history |
| `GET …/banking/accounts/:id/lines?status=&from=&to=` | banking.read | Statement lines with their matches and a rule-based suggestion |
| `POST …/banking/accounts/:id/auto-match` | banking.manage | Applies only suggestions where line and ledger line are each other's single same-amount candidate within 14 days |
| `GET …/banking/lines/:id/candidates?search=` | banking.read | Unmatched posted ledger lines on the account within 90 days, closest amount first |
| `POST …/banking/lines/:id/match` | banking.manage | Match to one or more ledger lines whose net equals the statement amount |
| `POST …/banking/lines/:id/unmatch` | banking.manage | Remove the match; an entry created from the line is reversed |
| `POST …/banking/lines/:id/create-entry` | banking.manage + journals.post | Post a bank entry to another (non-control) account and match it |
| `POST …/banking/lines/:id/record-payment` | banking.manage + sales/purchases.manage | Money in → customer receipt, money out → vendor payment, with allocations; matched to the line |
| `POST …/banking/lines/:id/exclude` / `include` | banking.manage | Exclude a line that is not a real movement (reason required) / include it again |
| `POST …/banking/accounts/:id/reconciliations/preview` | banking.read | Figures, uncleared items, unmatched lines and the reasons it does not reconcile |
| `POST …/banking/accounts/:id/reconciliations` | banking.reconcile | Complete; locks the lines it covers |
| `GET …/banking/accounts/:id/reconciliations` | banking.read | History, including undone ones |
| `POST …/banking/reconciliations/:id/undo` | banking.reconcile + periods.lock | Undo the latest reconciliation of an account (reason required) |
| `GET /v1/orgs/:orgId/attachments?entityType=&entityId=&includeRemoved=` | read permission of the record | Files on a document, payment, journal entry, bank statement line or expense claim (claimants see their own claims' receipts) |
| `POST /v1/orgs/:orgId/attachments?entityType=&entityId=&fileName=` | manage permission of the record (journals.create for journals) | Body is the raw file (`Content-Type: application/octet-stream` or the file type). PDF, PNG, JPEG or WebP detected from the bytes; at most 5 MB, 20 per record; exact duplicates refused |
| `GET …/attachments/:id/content?inline=1` | read permission of the record | The file, byte for byte, with `nosniff`, a sandbox CSP, `no-store` and `X-Checksum-SHA256` |
| `POST …/attachments/:id/remove` | manage permission of the record | Remove with a reason; the record and bytes are kept |
| `GET /v1/orgs/:orgId/approval-policies` | org.read | One rule per document type (INVOICE, CREDIT_NOTE, BILL, VENDOR_CREDIT) |
| `PUT /v1/orgs/:orgId/approval-policies/:kind` | org.manage | `minAmount`, `requireDifferentApprover`, `isActive` |
| `GET /v1/orgs/:orgId/approvals?status=&documentId=` | sales.read / purchases.read per request | Requests with `canApprove` for the caller |
| `GET /v1/orgs/:orgId/approvals/for-document/:documentId` | …read | Whether a rule applies, whether the draft may post, and its request history |
| `POST /v1/orgs/:orgId/approvals` | sales.manage / purchases.manage | Submit a draft covered by a rule |
| `POST …/approvals/:id/approve` | approvals.decide (+ journals.post with `post: true`) | Approve; with `post: true` also posts. A posting problem is returned as `postError` and the approval stays |
| `POST …/approvals/:id/reject` | approvals.decide | Reject with a reason |
| `POST …/approvals/:id/withdraw` | sales.manage / purchases.manage | Take back a pending request |
| `GET /v1/orgs/:orgId/expense-claims/options` | expenses.submit | Expense accounts and tax rates a claimant may use (employees cannot read the chart of accounts) |
| `GET /v1/orgs/:orgId/expense-claims?status=&mine=` | expenses.submit (own) / expenses.read (all) | Claims with totals by status |
| `GET /v1/orgs/:orgId/expense-claims/:id` | claimant or expenses.read | Claim with lines, duplicate hints, receipt count and the caller's allowed actions |
| `POST /v1/orgs/:orgId/expense-claims` | expenses.submit | New draft: `title`, `lines[]` of `date`, `accountId` (expense account), `merchant`, `description`, `amount` (tax included), `taxRateId` |
| `PUT` / `DELETE …/expense-claims/:id` | claimant | Edit a draft or rejected claim (it becomes a draft) / delete a draft |
| `POST …/expense-claims/:id/submit`, `…/withdraw` | claimant | Submit for approval / take it back |
| `POST …/expense-claims/:id/approve` | approvals.decide + journals.post, not the claimant | Approve and post (optional `date`, `note`) |
| `POST …/expense-claims/:id/reject` | approvals.decide, not the claimant | Reject with a reason |
| `POST …/expense-claims/:id/reimburse` | expenses.reimburse | Pay back from a bank or cash account (`bankAccountId`, `date`, `reference`) |
| `POST …/expense-claims/:id/void` | journals.reverse | Void an approved, unpaid claim; reverses its posting |
| `GET /v1/orgs/:orgId/gst/registration` | accounts.read | `{ registered: false }` or GSTIN, state, effective date, the six GST accounts and the first GST document date |
| `PUT /v1/orgs/:orgId/gst/registration` | accounts.manage | `gstin`, `legalName`, `effectiveFrom`, optional `accounts` (six account ids); without them the standard accounts 2310–2312 and 1451–1453 are created or reused. GSTIN and accounts are frozen once documents carry them |
| `GET /v1/orgs/:orgId/gst/states` | contacts.read | GST state codes, whether each levies SGST or UTGST, and 96 for exports |
| `POST /v1/orgs/:orgId/gst/check-gstin` | contacts.read | Format and check character of a GSTIN (no portal lookup) |
| `GET /v1/orgs/:orgId/gst/returns/gstr-1?from=&to=` | reports.read | GSTR-1 working paper (B2B, B2CL, exports, B2CS, credit notes, nil/exempt, HSN, documents issued) |
| `GET /v1/orgs/:orgId/gst/returns/gstr-3b?from=&to=` | reports.read | GSTR-3B working paper with ITC set-off and a comparison with the GST ledger accounts |
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
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `TOKEN_EXPIRED` (refresh and retry), `SESSION_REVOKED`, `SESSION_EXPIRED`, `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND`, `USER_NOT_FOUND` |
| 409 | `PERIOD_NOT_OPEN`, `ALREADY_POSTED`, `ENTRY_POSTED`, `ALREADY_REVERSED`, `IS_REVERSAL`, `NOT_POSTED`, `SYSTEM_ENTRY`, `DOCUMENT_POSTED`, `ALREADY_VOID`, `HAS_ALLOCATIONS`, `CREDIT_LIMIT_EXCEEDED`, `DUPLICATE_BILL`, `TOTAL_CHANGED`, `CONTACT_IN_USE`, `ALREADY_REMOVED`, `BANK_MATCHED`, `ALREADY_MATCHED`, `NOT_MATCHED`, `LINE_RECONCILED`, `LINE_EXCLUDED`, `NOTHING_NEW`, `PERIOD_RECONCILED`, `NOT_LATEST`, `ALREADY_UNDONE`, `ACCOUNT_IN_USE`, `NON_ZERO_BALANCE`, `HAS_CHILDREN`, `CONFLICT`, `FISCAL_YEAR_EXISTS`, `LEDGER_INTEGRITY` |
| 422 | `JOURNAL_INVALID` / `DOCUMENT_INVALID` / `STATEMENT_INVALID` / `RECONCILIATION_FAILED` (with `issues[]`), `INVALID_MATCH`, `OPENING_REQUIRED`, `OPENING_MISMATCH`, `CONTROL_ACCOUNT`, `INVALID_ALLOCATION`, `INVALID_BANK_ACCOUNT`, `TAX_ACCOUNT_REQUIRED`, `NOT_A_CUSTOMER`, `NOT_A_VENDOR`, `CONTACT_INACTIVE`, `NO_FISCAL_PERIOD`, `IDEMPOTENCY_KEY_REUSED`, `INVALID_PARENT`, `INVALID_SUBTYPE`, `WEAK_PASSWORD`, `WRONG_PASSWORD`, `SAME_PASSWORD`, `INVALID_DATE` |
| 429 | `RATE_LIMITED`, `TOO_MANY_ATTEMPTS` (both with `Retry-After`) |
