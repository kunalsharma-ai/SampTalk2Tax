# Security

What is built today, and what is planned. Nothing here is a compliance claim.

## Implemented (M1)

| Control | How | Evidence |
|---|---|---|
| Authentication | Email + password; scrypt (N=2^15, r=8, p=1, 16-byte salt, 64-byte key); timing-equalised failed logins; min length 12 | `packages/security`, `auth-tenancy.e2e.test.ts` |
| Tokens | HS256 JWT via `jose`, issuer/audience/expiry checked, default 1 h; secret ≥ 32 chars validated at boot | `apps/api/src/auth/tokens.service.ts` |
| Tenant isolation | Org-scoped routes `/v1/orgs/:orgId/...`; membership required; non-members get 404; every query filters by `org_id`; composite FKs make cross-tenant references impossible in the database | `auth-tenancy.e2e.test.ts › tenant isolation` |
| Authorisation | Role → permission map (OWNER, ADMIN, ACCOUNTANT, APPROVER, VIEWER × 28 permissions, plus EMPLOYEE); every org route declares a permission or is refused; admins cannot grant OWNER | `packages/security/src/permissions.ts` |
| Input validation | zod on all bodies/queries; amounts as decimal strings only; UUID checks | controllers |
| Ledger integrity | DB triggers (immutability, balance, period status, account state) | `DATABASE_SCHEMA.md` |
| Subledger integrity | Receivables/payables control accounts only reachable through documents and payments (API + trigger); posted documents, payments and allocations immutable; over-allocation refused at commit by a deferred trigger; allocations kept as history when removed | `sales-purchases.e2e.test.ts` |
| Bank reconciliation | Statement lines are immutable and never deleted; a ledger line matches at most one statement line (unique index); matched amounts must net to the statement amount (deferred trigger); matched entries cannot be reversed or voided until unmatched; reconciled lines are frozen; undoing a reconciliation needs `periods.lock` and a reason, and keeps the record; CSV import is parsed server-side with exact decimals and capped at 5,000 lines / ~2.5 MB | `banking.e2e.test.ts` |
| File uploads | Raw bytes only, capped at 5 MB (6 MB body limit, clear 413); type decided from magic bytes, never the browser's claim; only PDF/PNG/JPEG/WebP; file names stripped of paths and control characters; served with `nosniff`, a `sandbox` Content-Security-Policy, `no-store` and a checksum; record-level permission checks per file; bytes immutable in the database | `attachments-approvals.e2e.test.ts` |
| Segregation of duties | Approval rules per document type and amount; the approver must differ from the preparer and the submitter (service and trigger); posting a covered document without a matching approval is refused by a trigger; editing a draft cancels its approval | same |
| Least privilege for staff | EMPLOYEE role: its own expense claims and their receipts only; every ledger, report, banking and audit route answers 403, other people's claims 404; claim options endpoint so employees never read the chart of accounts | `expenses.e2e.test.ts › the Employee role` |
| Money controls | Credit limit enforced on posting (override is permission-checked and audited); duplicate vendor invoice numbers refused by service and unique index; idempotent payments keyed by `Idempotency-Key` + body hash | same |
| Audit trail | Append-only, SHA-256 hash-chained per org; verify endpoint; triggers block edits | `ledger.e2e.test.ts › audit trail` |
| HTTP hardening | `helmet` headers; CORS allow-list from config | `bootstrap.ts` |
| Secrets | Environment only; `.env` git-ignored; `.env.example` has placeholders | |
| Errors | Stable error codes; no stack traces or SQL in responses | `common/errors.ts` |
| Web session | Token kept in an httpOnly, SameSite=Lax cookie (`Secure` in production); browser JavaScript cannot read it | `apps/web/src/app/api/session/route.ts` |
| CSRF | Non-GET calls through the web proxy must carry `x-t2t-csrf: 1`, which a cross-site form cannot set; SameSite=Lax as a second layer | `apps/web/src/app/api/t2t/[...path]/route.ts`, browser test |
| Proxy allow-list | The web proxy forwards only `v1/*` API paths | same |
| Web headers | Baseline (no Content-Security-Policy yet): `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, permissions policy | `apps/web/next.config.ts` |
| Signed-out access | Middleware redirects to `/login` when the session cookie is missing; the API still checks every request | `apps/web/src/middleware.ts` |

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

The EMPLOYEE role has only `org.read` and `expenses.submit`.
| audit.read | ✓ | ✓ | ✓ | ✓ | |

## Planned (tracked as SEC-* in the registry)

Refresh tokens and revocation, MFA (TOTP/WebAuthn), SSO (OIDC/SAML), rate limiting and lockout, PostgreSQL row-level security as a second isolation layer, segregation-of-duties beyond document approvals (e.g. poster ≠ creator for journals and payments), malware scanning of uploaded files, field-level encryption for sensitive data, secrets manager, dependency and container scanning in CI, security event monitoring, backup/DR runbooks, AI security controls (prompt-injection defences, tool permissions, redaction, approval gates, kill switch).

## Reporting a vulnerability

Until a security contact is published, report privately to the repository owner rather than opening a public issue.
