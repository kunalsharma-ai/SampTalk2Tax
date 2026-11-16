# Security

What is built today, and what is planned. Nothing here is a compliance claim.

## Implemented (M1, M2 and M1 hardening)

| Control | How | Evidence |
|---|---|---|
| Authentication | Email + password; scrypt (N=2^15, r=8, p=1, 16-byte salt, 64-byte key); timing-equalised failed logins; min length 12 | `packages/security`, `auth-tenancy.e2e.test.ts` |
| Tokens | HS256 JWT via `jose`, issuer/audience/expiry checked, 15 min by default; each token names a server-side session that is checked on every request, so a revoked session stops working at once; secret ≥ 32 chars validated at boot | `apps/api/src/auth/tokens.service.ts`, `sessions.service.ts` |
| Sessions and refresh | Refresh token = session id + 256-bit secret; only its SHA-256 is stored. It rotates on every refresh. The token replaced last is accepted for 30 s (racing tabs); after that, using it again is treated as theft and ends the session (audited `session.refresh_reuse_detected`). Sessions end after 30 days, or 7 days without use. Users can list their sessions (browser, address, last activity), sign one out, or sign out all others; changing the password signs out all others. A trigger stops revoked sessions being revived, moved to another user, or extended | `sessions-security.e2e.test.ts › refresh tokens`, `› sessions and sign-out`, `› password change` |
| Sign-in lockout | Failed sign-ins are counted per email in PostgreSQL, whether or not the account exists (same answer either way). 5 failures within 15 minutes lock that email for 15 minutes (429 `TOO_MANY_ATTEMPTS` with `Retry-After`), even for the right password; a successful sign-in clears the count | `sessions-security.e2e.test.ts › sign-in lockout` |
| Rate limiting | Per client IP on sign-in, register, refresh and sign-out (20/min); per signed-in user, or per IP without a valid token, on every other route (600/min); 429 `RATE_LIMITED` with `Retry-After` and `RateLimit-*` headers. The client IP is read from `X-Forwarded-For` only across `TRUST_PROXY_HOPS` trusted proxies | `sessions-security.e2e.test.ts › rate limiting` |
| Tenant isolation | Org-scoped routes `/v1/orgs/:orgId/...`; membership required; non-members get 404; every query filters by `org_id`; composite FKs make cross-tenant references impossible in the database; row-level security (below) as a second layer | `auth-tenancy.e2e.test.ts › tenant isolation` |
| Row-level security | PostgreSQL policies on all 23 tables that hold tenant data, `FORCE`d so they bind the table owner the API connects as (which has no `BYPASSRLS`). Before every statement the API sets transaction-local `t2t.org_id`, `t2t.user_id` and `t2t.bypass` from the request (after the membership check), so a query that forgot its `org_id` filter, or names another tenant's id, returns nothing and cannot write. Memberships and organisations are also visible by the signed-in user's own id (for the organisation switcher). With no settings, tenant tables are empty and closed to writes. System access (`t2t.bypass`) is used only for the global sign-in audit chain, inside the one statement that needs it, and by code outside HTTP requests that opts in (demo seed, tests); the API server never opts in | `row-level-security.e2e.test.ts` |
| Authorisation | Role → permission map (OWNER, ADMIN, ACCOUNTANT, APPROVER, VIEWER × 37 permissions, plus EMPLOYEE); every org route declares a permission or is refused; admins cannot grant OWNER | `packages/security/src/permissions.ts` |
| Input validation | zod on all bodies/queries; amounts as decimal strings only; UUID checks | controllers |
| Ledger integrity | DB triggers (immutability, balance, period status, account state) | `DATABASE_SCHEMA.md` |
| Subledger integrity | Receivables/payables control accounts only reachable through documents and payments (API + trigger); posted documents, payments and allocations immutable; over-allocation refused at commit by a deferred trigger; allocations kept as history when removed | `sales-purchases.e2e.test.ts` |
| Bank reconciliation | Statement lines are immutable and never deleted; a ledger line matches at most one statement line (unique index); matched amounts must net to the statement amount (deferred trigger); matched entries cannot be reversed or voided until unmatched; reconciled lines are frozen; undoing a reconciliation needs `periods.lock` and a reason, and keeps the record; CSV import is parsed server-side with exact decimals and capped at 5,000 lines / ~2.5 MB | `banking.e2e.test.ts` |
| File uploads | Raw bytes only, capped at 5 MB (6 MB body limit, clear 413); type decided from magic bytes, never the browser's claim; only PDF/PNG/JPEG/WebP; file names stripped of paths and control characters; served with `nosniff`, a `sandbox` Content-Security-Policy, `no-store` and a checksum; record-level permission checks per file; bytes immutable in the database | `attachments-approvals.e2e.test.ts` |
| Segregation of duties | Approval rules per document type and amount; the approver must differ from the preparer and the submitter (service and trigger); posting a covered document without a matching approval is refused by a trigger; editing a draft cancels its approval | same |
| Invitations and membership | Invite links carry 256 random bits; only the SHA-256 is stored and the token is shown once. A link works once, for 7 days, and only for the invited email, so forwarding it does not let someone else join. The invitee's lookup is the one cross-tenant read, authorised by the token. Role changes and removals are limited to roles the actor may grant (admins cannot touch owners); an organisation always keeps an owner (service and trigger) | `invitations.e2e.test.ts`, `members-flow.test.mjs` |
| Least privilege for staff | EMPLOYEE role: its own expense claims and their receipts only; every ledger, report, banking and audit route answers 403, other people's claims 404; claim options endpoint so employees never read the chart of accounts | `expenses.e2e.test.ts › the Employee role` |
| Money controls | Credit limit enforced on posting (override is permission-checked and audited); duplicate vendor invoice numbers refused by service and unique index; idempotent payments keyed by `Idempotency-Key` + body hash | same |
| Audit trail | Append-only, SHA-256 hash-chained per org; verify endpoint; triggers block edits | `ledger.e2e.test.ts › audit trail` |
| HTTP hardening | `helmet` headers; CORS allow-list from config | `bootstrap.ts` |
| Secrets | Environment only; `.env` git-ignored; `.env.example` has placeholders | |
| Errors | Stable error codes; no stack traces or SQL in responses | `common/errors.ts` |
| Web session | Access and refresh tokens kept in httpOnly, SameSite=Lax cookies (`Secure` in production); browser JavaScript cannot read them. The proxy renews an expired access token once per request (one refresh call per token at a time), and signing out ends the session in the API | `apps/web/src/app/api/session/route.ts`, `apps/web/src/lib/session-cookies.ts`, `security-flow.test.mjs` |
| CSRF | Non-GET calls through the web proxy must carry `x-t2t-csrf: 1`, which a cross-site form cannot set; SameSite=Lax as a second layer | `apps/web/src/app/api/t2t/[...path]/route.ts`, browser test |
| Proxy allow-list | The web proxy forwards only `v1/*` API paths | same |
| Web headers | Baseline (no Content-Security-Policy yet): `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, permissions policy | `apps/web/next.config.ts` |
| Signed-out access | Middleware redirects to `/login` when both session cookies are missing; the API still checks every request | `apps/web/src/middleware.ts` |

## Role permissions

| Permission | OWNER | ADMIN | ACCOUNTANT | APPROVER | VIEWER |
|---|---|---|---|---|---|
| org/members/accounts/periods/journals/reports/contacts/sales/purchases/banking read | ✓ | ✓ | ✓ | ✓ | ✓ |
| org.manage, members.manage, periods.lock | ✓ | ✓ | | | |
| accounts.manage, periods.manage, journals.create, journals.reverse, contacts.manage, sales.manage, purchases.manage, banking.manage, banking.reconcile | ✓ | ✓ | ✓ | | |
| journals.post | ✓ | ✓ | ✓ | ✓ | |
| approvals.decide | ✓ | ✓ | | ✓ | |
| expenses.submit (own claims) | ✓ | ✓ | ✓ | ✓ | |
| expenses.read (all claims) | ✓ | ✓ | ✓ | ✓ | ✓ |
| expenses.reimburse | ✓ | ✓ | ✓ | | |
| audit.read | ✓ | ✓ | ✓ | ✓ | |
| copilot.use (ask the AI copilot; only one's own conversations) | ✓ | ✓ | ✓ | ✓ | ✓ |
| workflows.manage (automations, their webhooks and signing secrets; every task) | ✓ | ✓ | | | |
| collections.manage (draft, edit, send and reject AI payment reminders) | ✓ | ✓ | ✓ | | |
| close.manage (prepare a month-end close: tasks, AI review, post or reject proposed entries; posting also needs journals.post) | ✓ | ✓ | ✓ | | |
| assets.manage (fixed asset register: add, depreciate, dispose) | ✓ | ✓ | ✓ | | |
| tasks.use (tasks for oneself or one's role; give tasks) | ✓ | ✓ | ✓ | ✓ | ✓ |

The AI copilot sends questions and the figures it reads to Anthropic only when the server has `ANTHROPIC_API_KEY` **and** an owner or admin has turned it on for the organisation. Its tools are read-only and check the asking member's permissions; conversations are private to their author, down to row-level security. See [`AI_COPILOT.md`](AI_COPILOT.md).

The collections agent uses the same organisation switch: each customer's name, overdue invoices and payment history are sent to the model only while AI is on. The model can only submit a draft; it cannot send email or change records. Every amount and invoice number in a draft is checked against the customer's facts, the balances are checked again before sending, and only a member with `collections.manage` can send, to the address saved on the customer. Customer and invoice text is passed as data and the instructions say so. See [`AI_COLLECTIONS.md`](AI_COLLECTIONS.md).

AI reconciliation also uses that switch: bank line text and amounts, nearby ledger lines, open invoices or bills with contact names, the chart of accounts and earlier bank bookings are sent to the model only while AI is on. The model sees short references, never database ids, and can only submit a proposal; every reference is checked against what it was shown, and a person with `banking.manage` (plus the permission the action needs by hand) must accept it, which applies it through the same code and checks as by hand. See [`AI_RECONCILIATION.md`](AI_RECONCILIATION.md).

The month-end close review uses the same switch: account codes and names, monthly totals for the month and the three before, closing balances and the checklist are sent to the model only while AI is on. It can only submit a review; every proposed entry is checked (offered accounts only, never bank, cash or control accounts; balanced; plain amounts) and posted only by a person with `close.manage` and `journals.post`, through the normal journal code. Closing and reopening a month need `periods.lock` (owners and admins); the certification is kept by a database trigger, and a certified month cannot be unlocked from the periods page. See [`MONTH_END_CLOSE.md`](MONTH_END_CLOSE.md).

The AI control center lets owners and admins (`org.manage`) switch each agent off, cap its monthly tokens, and stop all AI for the organisation at once with a reason. Every agent goes through one guard before it starts and before each model call, so a stop, a switch-off or a reached budget also halts work already running; what it had not reached is marked as not done, and a review answered after a stop shows nothing it proposed. Accountants and approvers can see the control center (`audit.read`), not change it. Changes are in the audit trail. See [`AI_CONTROL_CENTER.md`](AI_CONTROL_CENTER.md).

Fixed assets: owners, admins and accountants (`assets.manage`) add assets, post and reverse depreciation and record disposals; everyone with `journals.read` can see the register. Every posting goes through the normal journal code (open periods, balanced, audit trail), and database triggers keep depreciated terms, posted lines and disposals from being changed. See [`FIXED_ASSETS.md`](FIXED_ASSETS.md).

Workflow webhooks (`docs/WORKFLOW_AUTOMATIONS.md`) are signed with a per-workflow HMAC-SHA256 secret. Outside development they may only reach public https addresses: the address is checked when saved, the host name is resolved when sending, every resolved address is checked against loopback, private, link-local (cloud metadata), CGNAT, reserved and IPv4-mapped forms, and the connection is pinned to the checked address. Redirects are not followed. `WEBHOOK_ALLOW_PRIVATE_NETWORKS` must stay false in production.

Workflow emails are plain text, so no HTML from facts reaches a mail client. Subjects are kept to one line (line breaks are refused when saved and removed after filling placeholders), and addresses come only from member accounts or the contact's saved email, never from free text in the workflow. Emails to customers and vendors carry no link into the app; emails to members link to the record, which still needs a sign-in. A test sends each email to the person testing only. Each email has `Auto-Submitted: auto-generated` and a Message-ID that is the same on every retry. The SMTP password lives only in `SMTP_URL` and is never shown or logged.

The EMPLOYEE role has only `org.read` and `expenses.submit`.

## Deployment notes for these controls

* Set `TRUST_PROXY_HOPS` on the API to the number of proxies in front of it (the web app's proxy counts as one). With 0, `X-Forwarded-For` is ignored.
* The web app reads the browser's address from `X-Forwarded-For`, counting `T2T_CLIENT_IP_HOPS` entries from the right (default 1). Next.js only fills that header when it is missing, so run the web app behind a reverse proxy that appends the client address. Exposed directly, a client can send a made-up address and dodge the per-IP limits; per-email lockout and per-user limits still apply.
* Rate-limit counters are kept in memory by each API process. With several instances the effective limit is multiplied by the instance count until a shared store (Redis) is added.

## Row-level security: how it works

* `apps/api/src/common/tenant-context.ts` keeps the request's tenant (organisation, user) in `AsyncLocalStorage`. Every request starts empty; the auth guard adds the user after checking the session, and the organisation after checking membership and permission.
* `apps/api/src/common/prisma.service.ts` wraps the Prisma client. A statement outside a transaction runs in a small transaction that first calls `set_config(..., true)`; an interactive transaction sets them once at its start. Settings are transaction-local, so a pooled connection never carries one request's tenant into another's.
* A statement sent on the root client from inside a transaction callback (instead of on `tx`) gets no settings and sees no tenant rows, so that mistake fails closed.
* Prisma queries are lazy: one created inside a request but first awaited outside it would run without the request's tenant. In the server that sees nothing (fail closed); code outside requests must opt in to system access explicitly.
* Creating an organisation points its transaction at the new id before inserting it.
* The API must connect as an ordinary role: a superuser or a role with `BYPASSRLS` skips every policy. The API checks its role at start-up, refuses to start in production with such a role, and warns otherwise. CI creates a non-superuser `talk2tax` role for the same reason.
* Data migrations that update tenant rows must run `SELECT set_config('t2t.bypass', 'on', true)` first; schema changes are not affected.
* Cost: each statement outside a transaction becomes a short transaction with one extra statement.

## Planned (tracked as SEC-* in the registry)

MFA (TOTP/WebAuthn), SSO (OIDC/SAML), a shared rate-limit store, segregation-of-duties beyond document approvals (e.g. poster ≠ creator for journals and payments), malware scanning of uploaded files, field-level encryption for sensitive data, secrets manager, dependency and container scanning in CI, security event monitoring, backup/DR runbooks, AI security controls (prompt-injection defences, tool permissions, redaction, approval gates, kill switch).

## Reporting a vulnerability

Until a security contact is published, report privately to the repository owner rather than opening a public issue.
