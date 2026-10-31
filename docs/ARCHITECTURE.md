# Architecture

## Shape: a modular monolith

Talk2Tax starts as one deployable API (`apps/api`, NestJS) over one PostgreSQL database, organised into domain modules with clear boundaries. Services can be extracted later when load or team structure justifies it (Directive Part 2: "Prefer a modular monolith initially").

```
                ┌───────────── apps/web (Next.js, next milestone) ─────────────┐
                                         │ HTTPS, bearer JWT
┌──────────────────────────────── apps/api (NestJS) ───────────────────────────────┐
│ AuthGuard (JWT → user → membership → permission)   ErrorFilter   zod validation │
│                                                                                   │
│  auth   organizations   accounts   periods   journals   reports   audit   health │
│    │          │             │          │         │          │        │            │
│    └──────────┴──── domain rules from packages/accounting-engine (pure TS) ────┘  │
│                         packages/security (roles, permissions, passwords)         │
└──────────────────────────────────────┬────────────────────────────────────────────┘
                                       │ Prisma + raw SQL (row locks)
                    PostgreSQL 16 — system of record, integrity triggers
```

## Repository layout (current)

```
apps/
  api/                     NestJS REST API, seed script, integration tests
packages/
  accounting-engine/       Pure double-entry rules: money, journals, periods, reports, CoA template
  database/                Prisma schema + SQL migrations (incl. integrity triggers)
  security/                Roles → permissions, scrypt password hashing
features/                  Feature registry inputs (modules.json, status.json) and output (registry.json)
scripts/                   generate-feature-registry.mjs
docs/                      This documentation set
infrastructure/            Docker init scripts
.github/workflows/ci.yml   Build, typecheck, unit + integration tests, registry freshness
```

The directive's full target layout (`apps/web|admin|mobile|documentation`, `packages/ui|design-system|tax-engine|ai-orchestration|…`, `services/*`) is the destination. Folders are created **when they contain working code**, not as empty placeholders (Part 50, rule 3: no static stand-ins).

## Request flow

1. `AuthGuard` (global) verifies the HS256 JWT (issuer, audience, expiry), loads the user, and for any route with `:orgId` loads the caller's membership. Non-members get **404** so organisation ids cannot be probed. The route's declared permission is checked against the role.
2. Controllers validate bodies and queries with zod. Money is accepted only as decimal **strings**.
3. Services run each write in a single database transaction, take the needed row locks, call the pure engine for validation, persist, and append an audit event in the same transaction.
4. `ErrorFilter` maps domain, validation, Prisma and database-trigger errors to stable JSON error codes.

## Concurrency model for posting

| Concern | Mechanism |
|---|---|
| Two postings racing a period lock | Posting holds the period row `FOR SHARE`; locking takes `FOR UPDATE` and waits. The DB trigger re-checks `OPEN` at post time. |
| Gap-free journal numbers | `INSERT … ON CONFLICT DO UPDATE … RETURNING` on `org_counters` (row lock per org). Numbers are assigned only at posting. |
| Duplicate submissions | Optional `Idempotency-Key` header, unique `(org_id, idempotency_key)`; same key + same body replays; same key + different body → 422. Concurrent duplicates resolve via the unique constraint. |
| Double reversal | Original locked `FOR UPDATE`, plus unique `reverses_entry_id`. |
| Audit chain forks | `pg_advisory_xact_lock` per org while appending. |

## Architecture decision records

### ADR-001 Modular monolith on NestJS + PostgreSQL
*Decision:* single NestJS app, domain modules, one Postgres. *Why:* transactional consistency across ledger operations is far simpler in one database; the directive asks to avoid premature microservices. *Revisit:* when a module needs independent scaling (document processing, AI workloads).

### ADR-002 Pure accounting engine package
*Decision:* all accounting rules live in `packages/accounting-engine` with no framework or database dependency. *Why:* the rules are unit-testable in milliseconds (including a randomised property test), reusable by future services (invoicing, payroll) and by the web app for live validation.

### ADR-003 Integrity enforced twice
*Decision:* the API validates, and PostgreSQL also refuses unbalanced posted entries (deferred constraint trigger), any change to posted entries/lines, posting into non-open periods, dates outside the period, header/inactive accounts, cross-tenant references (composite foreign keys) and audit-trail edits. *Why:* bugs, scripts or future services cannot corrupt the ledger by bypassing the API.

### ADR-004 Decimal strings end to end
*Decision:* money is `decimal.js` in code, `NUMERIC(24,6)` in the database (rates `NUMERIC(24,10)`), and strings in JSON. JS numbers are rejected. *Why:* Directive Part 5 forbids binary floating point.

### ADR-005 Pinned, proven dependency versions
*Decision:* TypeScript 5.9, NestJS 11, Prisma 6.19, zod 4, vitest 3, Node 22. *Why:* newer majors exist at the time of writing (TypeScript 7, NestJS 12, Prisma 7/8 pre-release) but have breaking changes in decorators, ESM and the Prisma client generator. Upgrade deliberately once the foundation is stable; tracked in KNOWN_LIMITATIONS.

### ADR-006 JWT via `jose`, passwords via Node scrypt
*Decision:* short-lived HS256 access tokens signed with `jose`; scrypt (N=2^15, r=8, p=1) with per-hash parameters for passwords. *Why:* no native build dependencies, well-reviewed primitives. Refresh tokens, MFA and SSO are later SEC items.

### ADR-007 Drafts then posting
*Decision:* journals can be saved as drafts (editable, deletable, excluded from all balances) and posted separately with a distinct permission (`journals.post`). *Why:* supports maker-checker review now and approval workflows later.

### ADR-008 Fiscal year labelled by end year
*Decision:* an April 2026–March 2027 year is FY2027. *Why:* matches Indian and UK convention; January-start years equal the calendar year.

## Planned components (not built yet)

* `apps/web` — Next.js App Router, TanStack Query/Table, React Hook Form + zod (shared schemas), Tailwind + shadcn/ui, ECharts/Recharts/D3 with table fallbacks.
* `packages/ai-orchestration` — model-agnostic gateway (Anthropic, OpenAI, Gemini, self-hosted), deterministic mock adapter for local use, tool permissioning, prompt versioning, cost tracking.
* Redis + BullMQ for background jobs; Temporal (or equivalent) for durable approval workflows; S3-compatible storage for documents; pgvector for retrieval; OpenSearch when search volume justifies it.
