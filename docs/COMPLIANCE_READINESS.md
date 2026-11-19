# Compliance readiness: SOC 2, ISO 27001 and data protection (SEC-027, SEC-028)

**Talk2Tax is not certified or attested against any framework.** No independent assessment has
been carried out. This document maps what the product does today to the controls those frameworks
ask about, so that an assessment can be prepared, and lists what is still missing.

## The rule on claims (SEC-028)

Nothing a customer or visitor can read may say Talk2Tax is SOC 2, ISO 27001, PCI DSS, HIPAA, GDPR
or DPDP certified, compliant, accredited or attested until an independent assessment of that
framework is complete. This is enforced, not just written down:

- `scripts/check-claims.mjs` reads the web app, the API's messages and e-mails, public files, the
  docs and the README, and fails on any sentence that pairs a framework with a claim word, unless
  the sentence denies or defers it ("not certified", "working toward").
- CI runs it on every pull request, with its own tests (`scripts/check-claims.test.mjs`).
- A framework can be added to `ASSESSED` in that script only with a completed assessment, recorded
  under Assessments below with the assessor, scope, period and report.

Sales material, contracts and questionnaires follow the same rule: describe the controls, and say
plainly that no certification is held.

## Assessments

| Framework | Status | Assessor | Scope and period | Report |
|---|---|---|---|---|
| SOC 2 Type I / II | Not started | — | — | — |
| ISO/IEC 27001:2022 | Not started | — | — | — |
| Penetration test | Not started; see [`PENETRATION_TESTING.md`](PENETRATION_TESTING.md) | — | — | — |

## SOC 2 trust services criteria

Product controls only. The organisational criteria (CC1 to CC5: governance, risk assessment,
policies, HR, vendor management) need written policies and evidence from the company that runs
Talk2Tax, which software alone cannot supply.

| Criterion | What Talk2Tax does | Evidence |
|---|---|---|
| CC6.1 Logical access | Tenant isolation on every collection, role permissions on every route, access rules by network, day and hour (SEC-004), platform roles for staff | `SECURITY.md` (Tenant isolation, Authorisation), `auth-tenancy.e2e.test.ts`, cross-tenant leakage tests (SEC-035) |
| CC6.1 Authentication | scrypt passwords, lockout, two-step sign-in (TOTP), single sign-on (OIDC), server-side sessions with revocation, known devices | `TWO_STEP_SIGN_IN.md`, `SINGLE_SIGN_ON.md`, SEC-005 to SEC-009 |
| CC6.1 Encryption keys | Stored secrets and uploaded files are AES-256-GCM sealed; keys rotate without downtime; secrets can come from mounted files and weak ones are refused in production | `SECURITY.md` (Encryption at rest, Encryption key rotation, Secrets management) |
| CC6.2/6.3 Access changes | Invitations single-use for the invited email; role changes and removals audited; admins cannot grant OWNER | `SECURITY.md` (Invitations and membership) |
| CC6.6 Boundary protection | Rate limits, CORS allow-list, CSRF header, web proxy forwards `v1/*` only, private-network blocking for webhooks and SSO | `SECURITY.md` |
| CC6.7 Transmission | HTTPS only with HSTS in production, TLS required to the database, mail and AI over TLS | `SECURITY.md` (Encryption in transit), `encryption-in-transit.e2e.test.ts` |
| CC6.8 Malicious software | Uploads type-checked by content and scanned (ClamAV) before they are stored | `SECURITY.md` (File uploads and malware scanning) |
| CC7.1 Vulnerabilities | Dependency audit on every pull request, CodeQL, container image scanning | `CI_CD.md`, `.github/workflows/security.yml` |
| CC7.2 Monitoring | Security event monitor (sign-in attacks, permission probing, exports), operations health, error log | `SECURITY.md` (Security event monitoring), `OPERATIONS.md` |
| CC7.3/7.4 Incidents | Alerts to platform admins; AI emergency shutdown; maintenance mode | SEC-023, SEC-038, `OPERATIONS.md` |
| CC8.1 Change management | Every change through a pull request with CI (build, types, unit, API and browser tests, containers); migrations versioned and recorded | `CI_CD.md`, `MONGODB.md` |
| A1.2 Backups | Encrypted, checksummed backups with retention; each run recorded | `DISASTER_RECOVERY.md` |
| A1.3 Recovery testing | Monthly restore drill into a scratch database; System health flags an overdue drill | `DISASTER_RECOVERY.md`, `backups.e2e.test.ts` |
| C1.1/C1.2 Confidentiality and disposal | Retention policies with legal holds; AI redaction of sensitive data | `SECURITY.md` (Data retention, AI data safety) |
| PI1 Processing integrity | Balanced, immutable ledger; period locks; hash-chained audit trail; decimal-only money | `ACCOUNTING_ENGINE.md`, `SECURITY.md` (Audit trail) |

## ISO/IEC 27001:2022 Annex A (technological controls)

| Control | Where |
|---|---|
| 5.15 Access control, 8.2 Privileged access, 8.3 Information access restriction | Roles and permissions, access rules (network, days, hours), platform roles, tenant isolation |
| 5.17 Authentication information, 8.5 Secure authentication | Password hashing, lockout, two-step sign-in, SSO, session revocation |
| 5.33 Protection of records, 8.15 Logging | Append-only hash-chained audit trail, AI action log, backup run log |
| 5.34 Privacy and protection of PII | Tenant isolation, encryption at rest, AI redaction, retention (see Data protection) |
| 8.7 Protection against malware | Upload scanning |
| 8.8 Management of technical vulnerabilities | Dependency audit, CodeQL, image scanning |
| 8.10 Information deletion | Retention policies and purge runner |
| 8.11 Data masking | AI data safety redaction |
| 8.13 Information backup | Encrypted backups and restore drills |
| 8.16 Monitoring activities | Security event monitor, System health |
| 8.20 to 8.22 Network security | HTTPS only, TLS to the database, private-network blocking, rate limits |
| 8.24 Use of cryptography | AES-256-GCM, scrypt, HKDF, key rotation, secret files |
| 8.25 to 8.29 Secure development and testing | Pull requests with CI, zod validation, tests per feature, `TEST_STRATEGY.md` |

The organisational, people and physical controls (clauses 4 to 10 and Annex A 5, 6 and 7) need an
information security management system run by the company: scope, risk register, statement of
applicability, policies, training, supplier reviews and internal audit. None of that exists yet.

## Data protection laws

Talk2Tax keeps personal data for its customers (their staff, customers and suppliers), so it acts
as a processor for most data and as a controller for its own users' accounts.

| Requirement (India DPDP Act 2023, EU GDPR) | Status |
|---|---|
| Security safeguards (DPDP s.8(5), GDPR art. 32) | In place: see the tables above |
| Storage limitation and erasure when the purpose ends (DPDP s.8(7), GDPR art. 5(1)(e)) | Retention policies per organisation with legal holds (SEC-020) |
| Data residency | Regions per organisation (`REGIONAL_DEPLOYMENT.md`) |
| Breach detection and notice (DPDP s.8(6), GDPR art. 33/34) | Detection in place (security monitor); the notice procedure to the Data Protection Board, supervisory authorities and people affected is not written yet |
| Rights of access, correction and erasure (DPDP s.11 to 13, GDPR art. 15 to 17) | Gap: no self-service export or erasure of one person's data; handled by hand today |
| Consent and notice (DPDP s.5 and 6, GDPR art. 6, 7, 13) | Gap: no privacy notice or consent records in the app |
| Processor terms (GDPR art. 28) | Gap: no data processing agreement template |
| Grievance officer / DPO contact | Gap: not published |

## Gaps to close before an assessment

1. Company policies and an ISMS (scope, risk register, statement of applicability, policies, training, supplier list).
2. Self-service personal data export and erasure, privacy notice and consent records.
3. A written incident response and breach notification procedure, with contacts.
4. An external penetration test ([`PENETRATION_TESTING.md`](PENETRATION_TESTING.md)) and fixes for what it finds.
5. Content-Security-Policy on the web app (listed under Web headers in `SECURITY.md`).
6. A security contact published through `SECURITY_CONTACT` (served as `/.well-known/security.txt`).
7. Choose an assessor and an observation period (SOC 2 Type II needs 3 to 12 months of evidence).
