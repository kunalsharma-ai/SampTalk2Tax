# Known limitations

Honest list of what does not exist or is incomplete. Kept current with each milestone.

## Product scope
* **No web UI yet.** Everything is API-only. Login, onboarding, accounting workspace and dashboards are the next milestone. For that reason no feature is marked "Implemented" in `FEATURE_STATUS.md`.
* Of 1,343 registry entries, 70 have progress (39 Tested rules/invariants and test capabilities, 31 Implementing). The rest are Not started.
* No AR, AP, banking, tax, payroll, procurement, expenses, treasury, FP&A, AI, agents, workflows, documents, integrations, subscriptions or admin modules yet.
* No AI functionality of any kind exists yet, and none is claimed.

## Accounting
* No year-end close (retained earnings roll-forward is shown as "unclosed earnings" on the balance sheet).
* No recurring journals, templates, accrual auto-reversal, revaluation, exchange-rate tables, intercompany, consolidation, subsidiary ledgers or cash-basis reporting.
* Dimensions are free-form key/values on lines; there are no dimension masters or dimension reports.
* The chart template is a generic SMB chart, not a statutory chart (e.g. Schedule III presentation is not implemented).
* Period CLOSED status exists but there is no close workflow; LOCKED/OPEN toggling is available to OWNER/ADMIN.

## Security
* Access tokens only (no refresh, revocation or logout); no MFA/SSO; no rate limiting or lockout on login.
* Tenant isolation is enforced in the application and by composite foreign keys; PostgreSQL row-level security is not enabled yet.
* Members are added by existing email only; no invitation emails.
* Segregation of duties (creator ≠ poster) is possible through roles but not enforced as a policy.

## Engineering
* Dependency majors are pinned below the newest releases (TypeScript 5.9 vs 7, NestJS 11 vs 12, Prisma 6 vs 7/8). See ADR-005.
* Audit appends serialise per organisation with an advisory lock; fine for current volume, to be revisited under load.
* The Docker image and compose `app` profile are written but have not been built in CI.
* Performance targets in the directive have not been benchmarked.
* `docs/COMPETITIVE_FEATURE_MATRIX.md` is a framework; competitor capabilities have not been researched or verified yet.

## Documents from Directive Part 48 not written yet
`TAX_ENGINE.md`, `AI_AGENT_ARCHITECTURE.md`, `AI_SAFETY_AND_GOVERNANCE.md`, `FINANCIAL_DIGITAL_TWIN.md`, `WORKFLOW_ENGINE.md`, `INTEGRATION_ARCHITECTURE.md`, `DESIGN_SYSTEM.md`, `DASHBOARD_SPECIFICATIONS.md`, `PRICING_STRATEGY.md`. They will be written with the milestone that builds each area rather than as speculative stubs.
