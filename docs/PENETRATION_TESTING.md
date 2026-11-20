# Penetration testing preparation (SEC-026)

How to get Talk2Tax ready for an external penetration test, what testers get, and what is in and
out of scope. No external test has been carried out yet; record each one under Assessments in
[`COMPLIANCE_READINESS.md`](COMPLIANCE_READINESS.md).

## Before the test

1. **Use a staging server, never production.** Deploy the release under test as for production
   ([`DEPLOYMENT.md`](DEPLOYMENT.md)): `NODE_ENV=production`, HTTPS only, TLS to the database, real
   secrets from files. Its own database, empty apart from the test accounts.
2. **Take a backup** and run a restore drill first ([`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)),
   so the server can be put back after destructive tests.
3. **Create the test accounts** on the staging API server:

   ```sh
   PENTEST_ACCOUNTS_ALLOWED=true pnpm --filter @talk2tax/api pentest:accounts --out pentest-accounts.json --domain <a domain you control>
   ```

   This makes two synthetic organisations: A with one person in each role (owner, admin,
   accountant, approver, viewer, employee) and B with an owner and a viewer, for tests across
   tenants. Passwords are random and only written to the file (mode 600, never printed). Send it
   to the testers through a channel that encrypts, and delete it afterwards.
4. **Platform admin access**, if in scope: grant one tester account a platform role with
   `pnpm --filter @talk2tax/api admin:grant --email <tester> --role SUPPORT` (or `SUPER_ADMIN`).
5. **Publish a contact**: set `SECURITY_CONTACT` on the web app (for example
   `mailto:security@your-domain`), and optionally `SECURITY_POLICY_URL`; the web app then serves
   `/.well-known/security.txt` (RFC 9116). Without a contact it answers 404.
6. **Tell the monitors**: the security event monitor will raise alerts during the test (sign-in
   attacks, permission probing). Note the test window and the testers' addresses for the team
   watching Platform admin → Security monitoring, so alerts are matched to the test, not ignored.
7. **Rate limits** stay on. If testers need higher limits for automated scans, raise
   `RATE_LIMIT_API_PER_MINUTE` on staging only and say so in the report.

## Scope

In scope:

- The web app and everything under `/api/*` it serves (session, proxy, portals, webhooks).
- The API under `/v1/*`, including the CRM external API with API keys, the customer and vendor
  portals (secret links), payment webhooks and single sign-on.
- Tenant isolation: every route under `/v1/orgs/:orgId/...` with accounts from organisation A
  against organisation B. A member of another organisation must get 404, never data.
- Role permissions: each role against routes it should not reach (403), and the employee role
  against everyone else's expense claims (404).
- File uploads (type checks, size limits, malware scanning), report exports, the AI copilot and
  agents (prompt injection, tool permissions, data redaction).
- Session handling: refresh token reuse, revocation, two-step sign-in, CSRF on the web proxy.

Out of scope, unless agreed in writing:

- Production servers and any real customer's data.
- Denial of service and load tests against shared infrastructure.
- Third parties: Anthropic, Stripe, Razorpay, mail providers, the identity providers used for
  single sign-on, and the cloud provider's own services.
- Social engineering and physical access.

## What testers should know

| Area | Where to read |
|---|---|
| Controls and how each is enforced | [`SECURITY.md`](SECURITY.md) |
| Roles and permissions | [`SECURITY.md`](SECURITY.md) (Role permissions) |
| API routes and the permission each needs | [`API_DOCUMENTATION.md`](API_DOCUMENTATION.md) |
| Single sign-on and two-step sign-in | [`SINGLE_SIGN_ON.md`](SINGLE_SIGN_ON.md), [`TWO_STEP_SIGN_IN.md`](TWO_STEP_SIGN_IN.md) |
| Known gaps (no Content-Security-Policy yet, and others) | [`COMPLIANCE_READINESS.md`](COMPLIANCE_READINESS.md), [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) |

Errors carry stable codes and never stack traces; every response has a request id
(`X-Request-Id`). Include it with each finding so it can be matched in the server logs.

## After the test

1. Restore the staging database from the backup, or drop it.
2. Delete `pentest-accounts.json` and revoke any platform role granted.
3. File each finding as a private issue with severity, the request ids and steps; fix critical
   and high findings before the next release, and retest them.
4. Record the test (tester, dates, scope, summary, report location) under Assessments in
   [`COMPLIANCE_READINESS.md`](COMPLIANCE_READINESS.md). A pen test report is not a certification;
   do not describe it as one ([SEC-028](COMPLIANCE_READINESS.md#the-rule-on-claims-sec-028)).
