# Security

What is built today, and what is planned. Nothing here is a compliance claim.

## Implemented (M1, M2 and M1 hardening)

| Control | How | Evidence |
|---|---|---|
| Authentication | Email + password; scrypt (N=2^15, r=8, p=1, 16-byte salt, 64-byte key); timing-equalised failed logins; min length 12 | `packages/security`, `auth-tenancy.e2e.test.ts` |
| Tokens | HS256 JWT via `jose`, issuer/audience/expiry checked, 15 min by default; each token names a server-side session that is checked on every request, so a revoked session stops working at once; secret ≥ 32 chars validated at boot | `apps/api/src/auth/tokens.service.ts`, `sessions.service.ts` |
| Sessions and refresh | Refresh token = session id + 256-bit secret; only its SHA-256 is stored. It rotates on every refresh. The token replaced last is accepted for 30 s (racing tabs); after that, using it again is treated as theft and ends the session (audited `session.refresh_reuse_detected`). Sessions end after 30 days, or 7 days without use. Users can list their sessions (browser, address, last activity), sign one out, or sign out all others; changing the password signs out all others. A trigger stops revoked sessions being revived, moved to another user, or extended | `sessions-security.e2e.test.ts › refresh tokens`, `› sessions and sign-out`, `› password change` |
| Known devices | The web app keeps a random device key in an httpOnly cookie (path `/api/session`, 400 days) and sends it on sign-in as `x-t2t-device`; the API keeps only its SHA-256 per person (`known_devices`) and names each session's device. A sign-in from a device not seen before, once the person has another one, is audited (`session.new_device`) and emailed to them through the server's mail server (device, address, time, and a link to sign it out); the email never holds up signing in. On the account page the person sees their devices, can trust the one in use for 30 days (or tick *Trust this device* when entering a two-step code), when signing in there skips the code (audited as `secondStep: TRUSTED_DEVICE`), stop trusting any device, or forget one, which signs its sessions out so it counts as new again. Sign-ins without a key (API clients) are not devices and never skip the code | `apps/api/src/auth/devices.service.ts`, `known-devices.e2e.test.ts`, `known-devices-flow.test.mjs` |
| Sign-in lockout | Failed sign-ins are counted per email in the database, whether or not the account exists (same answer either way). 5 failures within 15 minutes lock that email for 15 minutes (429 `TOO_MANY_ATTEMPTS` with `Retry-After`), even for the right password; a successful sign-in clears the count | `sessions-security.e2e.test.ts › sign-in lockout` |
| Rate limiting | Per client IP on sign-in, register, refresh and sign-out (20/min); per signed-in user, or per IP without a valid token, on every other route (600/min); 429 `RATE_LIMITED` with `Retry-After` and `RateLimit-*` headers. The client IP is read from `X-Forwarded-For` only across `TRUST_PROXY_HOPS` trusted proxies | `sessions-security.e2e.test.ts › rate limiting` |
| Tenant isolation | Org-scoped routes `/v1/orgs/:orgId/...`; membership required; non-members get 404; every query filters by `org_id`; the data layer refuses a reference to another tenant's record (composite foreign keys); tenant policies (below) as a second layer | `auth-tenancy.e2e.test.ts › tenant isolation` |
| Row-level security (tenant policies) | The data layer applies the policies PostgreSQL's row-level security had, on every tenant collection: each read and write runs with the request's organisation and user (set after the membership check), so a query that forgot its `org_id` filter, or names another tenant's id, returns nothing and cannot write. Memberships and organisations are also visible by the signed-in user's own id (for the organisation switcher). With no settings, tenant tables are empty and closed to writes. System access (`withSystemAccess`, the tenant context's bypass) is used only for the global sign-in audit chain, inside the one statement that needs it, and by code outside HTTP requests that opts in (demo seed, tests); the API server never opts in | `tenant-isolation.e2e.test.ts` |
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
| Evidence references | An audit event about a bill, invoice, payment, journal, bank line, expense claim or customer onboarding stores `data.evidence`: each file attached to that record at that moment (attachment id, file name, SHA-256), up to 20, hashed into the chain. Removed files drop out of later events; the audit trail page links each file | `audit-evidence.e2e.test.ts` |
| HTTP hardening | `helmet` headers; CORS allow-list from config | `bootstrap.ts` |
| Secrets | Environment only; `.env` git-ignored; `.env.example` has placeholders | |
| Errors | Stable error codes; no stack traces or SQL in responses | `common/errors.ts` |
| Web session | Access and refresh tokens kept in httpOnly, SameSite=Lax cookies (`Secure` in production); browser JavaScript cannot read them. The proxy renews an expired access token once per request (one refresh call per token at a time), and signing out ends the session in the API | `apps/web/src/app/api/session/route.ts`, `apps/web/src/lib/session-cookies.ts`, `security-flow.test.mjs` |
| CSRF | Non-GET calls through the web proxy must carry `x-t2t-csrf: 1`, which a cross-site form cannot set; SameSite=Lax as a second layer | `apps/web/src/app/api/t2t/[...path]/route.ts`, browser test |
| Proxy allow-list | The web proxy forwards only `v1/*` API paths | same |
| Web headers | Baseline (no Content-Security-Policy yet): `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, permissions policy | `apps/web/next.config.ts` |
| Signed-out access | The web proxy (`proxy.ts`, Next.js middleware) redirects to `/login` when both session cookies are missing; the API still checks every request | `apps/web/src/proxy.ts` |

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
| deferrals.manage (prepaid and deferred revenue schedules, releases, accruals) | ✓ | ✓ | ✓ | | |
| loans.manage (loans: add, installments, prepayments, rate changes, reversal) | ✓ | ✓ | ✓ | | |
| templates.manage (invoice templates: create, design, logos, HTML, default, archive) | ✓ | ✓ | ✓ | | |
| documents.sign (save one's own signature; e-sign posted invoices and credit notes) | ✓ | ✓ | ✓ | ✓ | |
| tasks.use (tasks for oneself or one's role; give tasks) | ✓ | ✓ | ✓ | ✓ | ✓ |

The AI copilot sends questions and the figures it reads to Anthropic only when there is a Claude key (the organisation's own from Settings → Integrations, or the server's `ANTHROPIC_API_KEY`) **and** an owner or admin has turned it on for the organisation. Its tools are read-only and check the asking member's permissions; conversations are private to their author, down to row-level security. See [`AI_COPILOT.md`](AI_COPILOT.md).

The collections agent uses the same organisation switch: each customer's name, overdue invoices and payment history are sent to the model only while AI is on. The model can only submit a draft; it cannot send email or change records. Every amount and invoice number in a draft is checked against the customer's facts, the balances are checked again before sending, and only a member with `collections.manage` can send, to the address saved on the customer. Customer and invoice text is passed as data and the instructions say so. See [`AI_COLLECTIONS.md`](AI_COLLECTIONS.md).

AI reconciliation also uses that switch: bank line text and amounts, nearby ledger lines, open invoices or bills with contact names, the chart of accounts and earlier bank bookings are sent to the model only while AI is on. The model sees short references, never database ids, and can only submit a proposal; every reference is checked against what it was shown, and a person with `banking.manage` (plus the permission the action needs by hand) must accept it, which applies it through the same code and checks as by hand. See [`AI_RECONCILIATION.md`](AI_RECONCILIATION.md).

The month-end close review uses the same switch: account codes and names, monthly totals for the month and the three before, closing balances and the checklist are sent to the model only while AI is on. It can only submit a review; every proposed entry is checked (offered accounts only, never bank, cash or control accounts; balanced; plain amounts) and posted only by a person with `close.manage` and `journals.post`, through the normal journal code. Closing and reopening a month need `periods.lock` (owners and admins); the certification is kept by a database trigger, and a certified month cannot be unlocked from the periods page. See [`MONTH_END_CLOSE.md`](MONTH_END_CLOSE.md).

The AI control center lets owners and admins (`org.manage`) switch each agent off, cap its monthly tokens, and stop all AI for the organisation at once with a reason. Every agent goes through one guard before it starts and before each model call, so a stop, a switch-off or a reached budget also halts work already running; what it had not reached is marked as not done, and a review answered after a stop shows nothing it proposed. Accountants and approvers can see the control center (`audit.read`), not change it. Changes are in the audit trail. See [`AI_CONTROL_CENTER.md`](AI_CONTROL_CENTER.md).

Fixed assets: owners, admins and accountants (`assets.manage`) add assets, post and reverse depreciation and record disposals; everyone with `journals.read` can see the register. Every posting goes through the normal journal code (open periods, balanced, audit trail), and database triggers keep depreciated terms, posted lines and disposals from being changed. See [`FIXED_ASSETS.md`](FIXED_ASSETS.md).

Prepaid expenses, deferred revenue and accruals: owners, admins and accountants (`deferrals.manage`) add and end schedules, post and reverse monthly releases, and post and cancel accruals; everyone with `journals.read` can see them. Every posting goes through the normal journal code, and database triggers keep released terms, release lines, ended schedules and accruals from being changed. See [`PREPAID_AND_DEFERRED.md`](PREPAID_AND_DEFERRED.md).

Departments and projects: owners, admins and accountants (`accounts.manage`) add and change them; everyone with `journals.read` sees them and `reports.read` reads profit by department or project. Line tags are checked by the API (same organisation, right kind, active) and by the database (composite foreign keys and a kind trigger), and values are never deleted. See [`FINANCIAL_DIMENSIONS.md`](FINANCIAL_DIMENSIONS.md).

Loans: owners, admins and accountants (`loans.manage`) add loans and record installments, prepayments and rate changes, and reverse the latest entry; everyone with `journals.read` sees loans and the treasury overview. Every posting goes through the normal journal code, and database triggers keep a loan's agreed terms and its entries from being changed or deleted. The app records borrowings and never moves money. See [`LOANS_AND_TREASURY.md`](LOANS_AND_TREASURY.md).

Invoice templates and e-signatures: owners, admins and accountants (`templates.manage`) design templates; HTML templates are untrusted input, checked on save (no scripts, event handlers, `javascript:` URLs, frames, forms, `<base>`/`<link>`/`<meta>` or network loads), filled with escaped values only, rendered with a `default-src 'none'` Content-Security-Policy and shown in a sandboxed frame without `allow-scripts`. Logos and signatures are sniffed from their bytes (PNG, JPEG, WebP; never SVG) and size-limited. Members with `documents.sign` (owners, admins, accountants, approvers) e-sign posted invoices with their own signature only; each signature keeps a copy of the image and a SHA-256 of the signed content, is never edited or deleted (triggers), and is re-verified on every view. It is an electronic signature with tamper evidence, not Aadhaar eSign or a DSC. See [`INVOICE_TEMPLATES.md`](INVOICE_TEMPLATES.md).

Report exports: the export route needs `reports.read`, and the ageing exports also `sales.read` or `purchases.read`; parameters are checked strictly and every id is looked up inside the organisation. CSV text that a spreadsheet would run as a formula is prefixed with an apostrophe and Excel cells are written as inline strings, never formulas. Files are sent as attachments with `nosniff` and `no-store`, and each export is audited as `report.exported` with the file's SHA-256. See [`REPORT_EXPORTS.md`](REPORT_EXPORTS.md).

Group consolidation: groups belong to the parent organisation (row-level security on its `org_id`). Only owners and admins of the parent change a group, and only organisations where the user is an owner or admin can be added (others read as not found). The consolidation reads each member's figures inside that member's own tenant context and needs `reports.read` in every member; members the user does not belong to are never named. Intercompany transactions need `journals.post` (or `journals.reverse`) in both companies; both journals are written in one database transaction that is pointed at each company in turn, so each company's row-level security, period locks and audit apply to its own entry, and the ledger's deferred checks run for each entry under its own company. The list shows only transactions between companies whose journals the user can read. See [`CONSOLIDATION.md`](CONSOLIDATION.md).

Digital twin: scenarios are tenant rows with forced row-level security. Reading and simulating need `reports.read`; saving, changing and deleting need `scenarios.manage` (owners, admins, accountants), and each is audited. The twin only reads posted figures and never writes to the ledger. See [`DIGITAL_TWIN.md`](DIGITAL_TWIN.md). Approving scenarios needs `scenarios.approve` (owners, admins, approvers); the submitter can never decide their own scenario, and versions are immutable at the database level. See [`WAR_ROOM.md`](WAR_ROOM.md). Recovery plans: reading needs `reports.read`, changing needs `scenarios.manage`; action owners must be members; the planner never posts, pays, borrows or contacts anyone. See [`RECOVERY_PLANNER.md`](RECOVERY_PLANNER.md). Virtual CFO: reading needs `reports.read`, and answers listing customer or vendor records also need `sales.read` or `purchases.read`; packs need `cfo.reports` (owners, admins, accountants); a final pack is immutable at the database level; the AI summary goes through the AI control guard, sees only the pack's facts and is rejected if it quotes any figure not in them. See [`VIRTUAL_CFO.md`](VIRTUAL_CFO.md). Benchmarking: opt-in with recorded consent, decided by `org.manage`; the pool has no organisation id (a random key per participant, replaced on rejoining) and row-level security lets only the system read it; only medians (5+ other participants) and quartiles (10+) are returned, smaller groups are suppressed and counts are banded; withdrawing deletes the contribution; demo organisations use a separate synthetic pool. See [`BENCHMARKING.md`](BENCHMARKING.md). Relationship explorer: read-only, needs `reports.read` plus both `sales.read` and `purchases.read` because it shows both ledgers together; every query is scoped to the organisation under row-level security. See [`KNOWLEDGE_GRAPH.md`](KNOWLEDGE_GRAPH.md). Decision memory: reading needs `reports.read`, recording, changing, reviewing and withdrawing need `decisions.manage` (owners, admins, accountants, approvers); reviewed and withdrawn decisions are locked by a database trigger; every change is audited with before and after. See [`DECISION_MEMORY.md`](DECISION_MEMORY.md). Forecast lab: reading needs `reports.read`, saving a run needs `budgets.manage` and is audited; saved runs are immutable at the database level; the lab only reads posted figures. See [`FORECAST_LAB.md`](FORECAST_LAB.md). Disaster simulation: reading and running need `reports.read` plus `sales.read` and `purchases.read` (shocks name customers and suppliers); saving, changing, deleting and copying to the twin need `scenarios.manage` and are audited; it never posts. See [`DISASTER_SIMULATION.md`](DISASTER_SIMULATION.md). Policy studio: reading needs `reports.read`; writing and drafting with AI need `policies.manage` (owners, admins, accountants); approving, which turns rules into running workflows, and retiring need `workflows.manage` and the approver can never be the last editor; tests must pass before approval; policy work goes to roles, never one person; versions are immutable at the database level; AI drafts go through the AI control guard, are recorded with their tokens, and are never saved or run without a person. See [`POLICY_STUDIO.md`](POLICY_STUDIO.md). Dashboards: viewing needs `reports.read`, customer widgets also `sales.read`; building, changing, deleting and drafting with AI need `dashboards.manage` and are audited; configurations may only use approved metrics and every figure is computed from the books, never by the AI; AI drafts go through the AI control guard and are recorded with their tokens. See [`AI_DASHBOARDS.md`](AI_DASHBOARDS.md). Report designer: viewing needs `reports.read`; designing, producing, writing commentary, finalising and deleting need `reports.design` (owners, admins, accountants) and are audited; figures are frozen when a report is produced; AI commentary sees only the report's facts and is thrown away if it quotes a number not in them, while a person's numbers not in the facts are flagged; a final report is immutable at the database level. See [`REPORT_DESIGNER.md`](REPORT_DESIGNER.md). Voice assistant: the browser turns speech into text and Talk2Tax never receives audio; the copilot can only propose three actions (a task, acknowledging or dismissing an alert), each checked when proposed, confirmed on screen only by the member who asked within 15 minutes (never by speech; sensitive ones ask twice), re-checked against their permission at that moment and carried out in the same transaction that records the decision; decided actions are immutable at the database level and every step is audited. See [`VOICE_ASSISTANT.md`](VOICE_ASSISTANT.md). Business impact: reading and running need `reports.read` plus `sales.read` and `purchases.read` (changes name customers and suppliers); saving, changing, deleting and copying to the twin need `scenarios.manage` and are audited; it never posts. See [`BUSINESS_IMPACT.md`](BUSINESS_IMPACT.md). Opportunity intelligence: read-only, needs `reports.read` and `sales.read` (opportunities name customers); taking one forward creates an audited impact assessment and needs `scenarios.manage` and `purchases.read`. See [`OPPORTUNITY_INTELLIGENCE.md`](OPPORTUNITY_INTELLIGENCE.md). Alert priority and tasks: the task setting is read with `reports.read` and changed with `alerts.manage`, audited with before and after; background checks run per organisation under its own row-level security context, as the system; alert tasks go to a role, never to one person, and are closed automatically only by the alert they link to. See [`ALERTS_AND_LEAKAGE.md`](ALERTS_AND_LEAKAGE.md). Languages and formats: a person's display preferences are theirs alone and need only a signed-in session; the organisation time zone needs `org.manage` and is audited; values are checked against fixed lists and real IANA zones in the API and by database CHECKs; none of these change figures or tax behaviour. See [`LANGUAGES_AND_FORMATS.md`](LANGUAGES_AND_FORMATS.md). Country modules: the catalogue is the same for everyone signed in and holds no tenant data; an organisation's module needs `org.read`; adding starter rates needs `accounts.manage`, runs in one transaction under row-level security, never changes an existing rate, and is audited per rate and as a whole. Hiding India-only pages is a convenience; the API refuses that work for other countries on its own. See [`COUNTRY_MODULES.md`](COUNTRY_MODULES.md). Statutory statements: read-only, need `reports.read`, and read posted journals of the organisation under row-level security. See [`LOCAL_FINANCIAL_REPORTING.md`](LOCAL_FINANCIAL_REPORTING.md). Exchange rates and revaluation: reading needs `reports.read`; recording rates and posting revaluations need `accounts.manage` and are audited; both tables have forced row-level security, and revaluation records are immutable at the database level. See [`MULTI_CURRENCY.md`](MULTI_CURRENCY.md).

Workflow webhooks (`docs/WORKFLOW_AUTOMATIONS.md`) are signed with a per-workflow HMAC-SHA256 secret. Outside development they may only reach public https addresses: the address is checked when saved, the host name is resolved when sending, every resolved address is checked against loopback, private, link-local (cloud metadata), CGNAT, reserved and IPv4-mapped forms, and the connection is pinned to the checked address. Redirects are not followed. `WEBHOOK_ALLOW_PRIVATE_NETWORKS` must stay false in production.

Workflow emails are plain text, so no HTML from facts reaches a mail client. Subjects are kept to one line (line breaks are refused when saved and removed after filling placeholders), and addresses come only from member accounts or the contact's saved email, never from free text in the workflow. Emails to customers and vendors carry no link into the app; emails to members link to the record, which still needs a sign-in. A test sends each email to the person testing only. Each email has `Auto-Submitted: auto-generated` and a Message-ID that is the same on every retry. The SMTP password lives only in `SMTP_URL` and is never shown or logged.

The EMPLOYEE role has only `org.read` and `expenses.submit`.

## Deployment notes for these controls

* Set `TRUST_PROXY_HOPS` on the API to the number of proxies in front of it (the web app's proxy counts as one). With 0, `X-Forwarded-For` is ignored.
* The web app reads the browser's address from `X-Forwarded-For`, counting `T2T_CLIENT_IP_HOPS` entries from the right (default 1). Next.js only fills that header when it is missing, so run the web app behind a reverse proxy that appends the client address. Exposed directly, a client can send a made-up address and dodge the per-IP limits; per-email lockout and per-user limits still apply.
* Rate-limit counters are kept in memory by each API process. With several instances the effective limit is multiplied by the instance count until a shared store (Redis) is added.

## Tenant policies: how they work

* `apps/api/src/common/tenant-context.ts` keeps the request's tenant (organisation, user) in `AsyncLocalStorage`. Every request starts empty; the auth guard adds the user after checking the session, and the organisation after checking membership and permission.
* Every tenant collection is scoped by that context (`ScopedCollection`): the organisation is added to every filter, insert, update, delete and aggregation, including each `$lookup`. With no organisation and no system bypass, tenant collections show nothing and refuse writes, so a query that escapes its request fails closed.
* The data client (`apps/api/src/db/data-client.ts`) answers the model API from those collections, and also applies the policies that were not "this organisation" (a copilot conversation only to its author, the benchmark pool only to the system). A write must belong to the current organisation.
* Code outside requests (runners, the demo seed, tests) must opt in to system access explicitly.
* Creating an organisation points its transaction at the new id before inserting it (`useOrgInTx`).
* MongoDB migrations run with system access, since they are not requests.
* The MongoDB user the API connects as needs `readWrite` on its own database only.

## Planned (tracked as SEC-* in the registry)

MFA (TOTP/WebAuthn), SSO (OIDC/SAML), a shared rate-limit store, segregation-of-duties beyond document approvals (e.g. poster ≠ creator for journals and payments), malware scanning of uploaded files, field-level encryption for sensitive data, secrets manager, dependency and container scanning in CI, security event monitoring, backup/DR runbooks, AI security controls (prompt-injection defences, tool permissions, redaction, approval gates, kill switch).

## Reporting a vulnerability

Until a security contact is published, report privately to the repository owner rather than opening a public issue.

## Integration secrets

API keys and SMTP passwords that owners and admins enter in Settings → Integrations are encrypted with AES-256-GCM before storage (key from `INTEGRATIONS_ENCRYPTION_KEY`, or derived from `JWT_SECRET` with HKDF-SHA256 under its own label), in a tenant table with forced row-level security. They are never returned to the browser or written to the audit trail (only whether they changed and their last four characters). Only `org.manage` can see or change integrations. On a public server, mail servers on private, loopback or link-local addresses and unencrypted SMTP are refused, and the connection goes to the address checked. See [`INTEGRATIONS.md`](INTEGRATIONS.md).

## Encryption key rotation (SEC-013)

Every secret stored in the app is sealed with AES-256-GCM and records the short id of the key that
sealed it. This covers organisations' AI and email keys, payment gateway keys and webhook secrets
(organisations' and the platform's), CRM webhook signing secrets, and two-step sign-in
authenticators.

To rotate the key:

1. Set a new `INTEGRATIONS_ENCRYPTION_KEY`.
2. List the old one in `INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS`, comma-separated. When moving off
   the key derived from `JWT_SECRET`, write it as `jwt:<old JWT_SECRET>`.
3. Restart the server.

Secrets under a previous key keep working. **Platform admin → Encryption keys** counts each kind of
secret by key: current, previous, or one no listed key opens. **Re-encrypt** opens every secret
under a previous key and seals it again with the current key.

* Re-encrypting is safe to repeat.
* It needs a platform `SUPER_ADMIN`.
* It is audited as `platform.secrets_resealed`, with counts only and never the secrets.
* Secrets nothing can open are never changed. Whoever set them up enters them again.

Once nothing is left under the old key, remove it from the configuration. An active two-step
sign-in can be re-sealed in place, because the cipher and key id change together. Its secret
still cannot be swapped under the same key.

API: `GET /v1/admin/encryption-keys` (platform.read) and `POST /v1/admin/encryption-keys/reseal`
(platform.manage).

Not built: an external key manager (KMS or Vault), rotating `JWT_SECRET` for sign-in tokens
without signing everyone out, and per-organisation keys.

## Single sign-on (SEC-006/007)

Organisations can sign in with their own OpenID Connect provider. The setup uses the code flow
with PKCE and browser-bound state, and signed ID tokens are checked against the provider's keys.
Domains are proved by DNS TXT records, and SSO can optionally be required for members, though
owners keep their password. Requests to the provider are guarded against reaching private
networks. See [`SINGLE_SIGN_ON.md`](SINGLE_SIGN_ON.md).

## File uploads and malware scanning (SEC-018/019)

Files are uploaded as attachments to records, as tax notice files, and by vendors through the
vendor portal. Each one is checked before it is kept:

1. **Size and type.** The limit is 5 MB. The type is read from the file's first bytes, never the
   browser's claim, and only PDF, PNG, JPEG and WebP are accepted. File names lose path
   separators and control characters.
2. **Active content.** A PDF that can run JavaScript, launch programs, carry embedded files, use
   XFA or RichMedia, or submit or import form data is refused. Names written with `#xx` escapes,
   and keys inside compressed object streams, are checked too. This applies with or without a
   virus scanner.
3. **Malware.** With `CLAMAV_URL=tcp://host:3310`, every file is streamed to ClamAV's daemon
   (INSTREAM) before it is kept.
   - A file with a signature is refused (`422 FILE_INFECTED`).
   - While the scanner cannot answer, uploads are refused too (`503 FILE_SCAN_UNAVAILABLE`):
     fail closed.
   - `CLAMAV_TIMEOUT_SECONDS` limits each scan (default 15).

Every check is recorded in `file_scans` (insert-only), and each refusal is written to the
organisation's audit trail as `file.refused`. Refused files are not kept, only their name, size
and SHA-256. Platform admin → **File scanning** shows the scanner's state and version, the last
30 days of checks, and the latest refused files.

Files are always served back as downloads, with `X-Content-Type-Options: nosniff` and a
sandboxing Content-Security-Policy.

Not built: re-scanning files already stored when signatures update. Bank statement files (parsed,
not kept as files) and invoice template logos (images up to 500 KB, type checked from their bytes)
do not go through the virus scanner.

## Data retention (SEC-020)

Settings → Data retention (permission `audit.read` to view, `org.manage` to change) sets how long
each kind of working data is kept. Every kind is kept until an owner chooses a period.

| Data | Shortest period | What is deleted |
| --- | --- | --- |
| Copilot conversations | 90 days | Conversations with no new question for the period, with their messages. A conversation waiting for an approval is kept. Token usage records for budgets and invoices are separate and kept. |
| CRM webhook delivery log | 30 days | Deliveries that finished (succeeded or failed) more than the period ago. Deliveries still being retried are kept. |

The longest period that can be set is 3,650 days; for longer, choose Keep. A runner
(`RETENTION_RUNNER_INTERVAL_SECONDS`, default daily, `0` to switch it off) applies the periods
for every organisation, and **Apply now** applies them at once. Each run that deleted something,
and each Apply now, is listed on the page and audited as `retention.purged` with counts only;
period changes are audited as `retention.policy_changed`.

Accounting, tax and payroll records and the audit trail are never deleted on a schedule. The page
lists the minimum periods for India: books of account 8 years (Companies Act, 2013, s.128(5)),
GST records 72 months from the annual return's due date (CGST Act, 2017, s.36), and income-tax
records 6 years from the end of the assessment year (Income-tax Rules, 1962, rule 6F(5)).

Not built: periods for uploaded files and email logs, legal hold, and an export before deletion.

## Security event monitoring (SEC-023)

The audit trail already records sign-ins, lockouts, two-step failures, role changes and refused
uploads. The security monitor reads it for the people who run Talk2Tax, under **Platform admin →
Security monitoring**.

* **Events**: 23 audit actions count as security events, each HIGH or MEDIUM: for example locked
  sign-ins, failed two-step codes, two-step turned off, refused single sign-ons and uploads,
  platform role changes, new devices, password changes, API keys, member role changes and
  removals. The page lists the last 7 days with the person, organisation, actor and address, and
  can filter by severity.
* **Alerts**: every `SECURITY_MONITOR_INTERVAL_SECONDS` (default 300; 0 = off), or on **Check
  now**, the monitor reads the last two hours and applies six rules:
  * many sign-ins locked within one hour (`SECURITY_LOCKOUT_ALERT_COUNT`, default 5), across
    Talk2Tax;
  * failed two-step codes after a right password (one alert per person and day);
  * a platform role given or changed;
  * a platform administrator turning two-step sign-in off;
  * an upload with a virus signature;
  * five or more refused single sign-ons into one organisation within an hour.
* Each finding is one row in `security_alerts` (unique by rule and key). Repeats add to its count.
  What was found never changes, and alerts are never deleted (guard).
* Each new alert is emailed once to every platform super admin through the server's own mail
  server (`SMTP_*`). A failure to send is shown on the alert.
* Platform admins (super admin or support) can read the page and API: `GET /v1/admin/security`
  (`?severity=HIGH|MEDIUM`). Super admins run a check (`POST /v1/admin/security/scan`) and
  acknowledge an alert with a note (`POST /v1/admin/security/alerts/:id/acknowledge`).
  Acknowledging is audited as `security.alert_acknowledged`, and new alerts as
  `security.alert_opened`.

## AI model access (SEC-034)

Platform administrators choose the AI models allowed across Talk2Tax, and each organisation can
narrow that list. A model that is not allowed is refused before any call. See
[`AI_CONTROL_CENTER.md`](AI_CONTROL_CENTER.md#model-access-sec-034).

## AI data safety (SEC-029, SEC-031)

The copilot replaces card numbers, Aadhaar numbers and secrets in everything it sends to the AI
model, and bank accounts, PAN, emails and phones as each organisation chooses. Tool data that reads
like instructions to an AI is marked as untrusted, and proposals stop for that answer. Details in
[`AI_CONTROL_CENTER.md`](AI_CONTROL_CENTER.md#what-the-copilot-sends-to-the-model-sec-029-sec-031).
Other AI agents (collections, bank reconciliation, close review, virtual CFO) do not do this yet.

## Data residency

Each organisation is tagged with the region its data lives in, and the auth guard refuses any organisation route for an organisation from another region (`421 WRONG_REGION`) after the membership check, so a restored or copied database cannot serve or change an organisation outside its home region. Moves are audited (`organization.region_moved`). See [`REGIONAL_DEPLOYMENT.md`](REGIONAL_DEPLOYMENT.md).

## Platform administration

Platform roles (`SUPER_ADMIN`, `SUPPORT`) are separate from organisation roles and never grant access to an organisation's routes: those still need membership. Admin views read organisation metadata (name, country, region, members, status) as the system and select no financial columns. The first administrator is named with the `admin:grant` command on the API host; the platform keeps at least one active super admin; every platform action is audited, and suspensions are written to the organisation's own audit trail. Suspended organisations are read-only (`423 ORG_SUSPENDED` on any change). See [`PLATFORM_ADMINISTRATION.md`](PLATFORM_ADMINISTRATION.md).
