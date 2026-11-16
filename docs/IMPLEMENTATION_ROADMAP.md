# Implementation roadmap

The directive (Part 47) defines milestones M0–M9. This file tracks what each one contains and where it stands. Feature-level status is in [`FEATURE_STATUS.md`](FEATURE_STATUS.md).

| Milestone | Scope | Status |
|---|---|---|
| **M0 Discovery & architecture** | PRD, competitive matrix, domain model, ADRs, DB design, API contracts, security, AI architecture, design system spec, roadmap, dependency map | **Partly done.** Done: PRD, feature registry (1,343 entries), architecture + ADRs, database schema, accounting engine spec, security, API docs, test strategy, deployment, roadmap. Not done: competitive matrix research (framework only), AI architecture, design system spec, tax engine, workflow engine, integration architecture, dashboard specs, pricing |
| **M1 Functional foundation** | Monorepo, auth, tenants, onboarding, RBAC, database, accounting engine, GL, CoA, journal posting, basic reports, initial dashboard | **Backend done, UI not started.** All backend items are built and tested. Remaining: `apps/web` (login, registration, onboarding, accounting workspace, initial dashboard), design system package |
| M2 Core finance | AR, AP, banking, reconciliation, expenses, customers, vendors, documents, approval workflows | Not started |
| M3 Tax & payroll | Validated India GST/TDS workflows, payroll finance, compliance calendars | Not started |
| M4 Financial intelligence | Forecasting, budgeting, analytics, AI copilot, alerts, leakage | Not started |
| M5 Autonomous finance | Agent framework, control center, workflow automation, AI reconciliation/collections/close, explainable AI log | Not started |
| M6 Enterprise finance | Multi-entity, consolidation, treasury, fixed assets, advanced reporting, governance | Not started |
| M7 Signature innovations | Digital twin, war room, virtual CFO, recovery planner, knowledge graph, decision memory | Not started |
| M8 Globalisation | Verified country modules, i18n, regional deployment | Not started |
| M9 Commercial SaaS | Subscription billing, plan enforcement, super admin, support, metering, observability, pipelines | Not started |

## Next priorities (proposed order)

1. **M1 web app** (`apps/web`, Next.js): login/registration, organisation onboarding wizard, chart of accounts, journal entry grid with live balance check, period management, trial balance / P&L / balance sheet / ledger views, audit trail viewer, initial owner dashboard on real data. Plus `packages/ui` + `packages/design-system` with the Talk2Tax tokens from Part 27.
2. **M1 hardening:** refresh tokens + logout, rate limiting on auth, PostgreSQL row-level security as a second tenant-isolation layer, financial dimension masters, recurring journal templates, year-end close to retained earnings.
3. **M0 remainder:** competitive matrix with sourced, dated research; AI architecture (gateway with mock adapters); design system spec.
4. **M2:** customers/vendors, invoices and bills posting to the GL through the same engine, bank statement import and reconciliation.

## Dependency map (top level)

```
SEC ─┬─> GL ─┬─> AR ─┬─> TAX ──> PAY
     │       ├─> AP ─┘
     │       ├─> BANK ──> TRS
     │       ├─> RPT ──> FPA ──> TWIN ──> RECOV
     │       └─> ENT (multi-entity, consolidation)
     ├─> WFLOW ──> AGENT
     └─> AIGW (AI gateway) ──> VCFO, DOC, AGENT, copilot
DS ──> UX, NAV, DASH ──> CMD, WAR
```
