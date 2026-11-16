# Implementation roadmap

The directive (Part 47) defines milestones M0–M9. This file tracks what each one contains and where it stands. Feature-level status is in [`FEATURE_STATUS.md`](FEATURE_STATUS.md).

| Milestone | Scope | Status |
|---|---|---|
| **M0 Discovery & architecture** | PRD, competitive matrix, domain model, ADRs, DB design, API contracts, security, AI architecture, design system spec, roadmap, dependency map | **Partly done.** Done: PRD, feature registry (1,343 entries), architecture + ADRs, database schema, accounting engine spec, security, API docs, test strategy, deployment, roadmap. Not done: competitive matrix research (framework only), AI architecture, design system spec, tax engine, workflow engine, integration architecture, dashboard specs, pricing |
| **M1 Functional foundation** | Monorepo, auth, tenants, onboarding, RBAC, database, accounting engine, GL, CoA, journal posting, basic reports, initial dashboard | **Built.** Backend and web app are built and tested (unit, integration and browser tests). Hardening so far: server-side sessions with rotating refresh tokens, revocation and a Security page; sign-in lockout and rate limiting; PostgreSQL row-level security; member invitations, role changes and removal. M1 is complete |
| **M2 Core finance** | AR, AP, banking, reconciliation, expenses, customers, vendors, documents, approval workflows | **In progress.** Slice 1 built and tested: customers, vendors, tax rates, invoices, credit notes, bills, vendor credits, receipts, payments, allocation, statements, ageing and slice 2 built and tested: bank accounts, CSV statement import, matching, bank entries and receipts from statement lines, reconciliation with history and undo; slice 3 built and tested: attachments on records and single-step approval rules for sales and purchase documents; slice 4 built and tested: employee expense claims with receipts, approval and reimbursement (see [`MILESTONE_REPORT_M2.md`](MILESTONE_REPORT_M2.md)). The M2 scope in the directive is covered at a first level; remaining depth is listed in KNOWN_LIMITATIONS |
| M3 Tax & payroll | Validated India GST/TDS workflows, payroll finance, compliance calendars | **In progress.** Slice 1 built and tested: India GST (registration, GSTIN check, GST rates with categories, place of supply, CGST/SGST/UTGST/IGST split and posting, HSN/SAC, GSTR-1 and GSTR-3B working papers with ITC set-off and a ledger check); see [`TAX_ENGINE_INDIA_GST.md`](TAX_ENGINE_INDIA_GST.md). Slice 2 built and tested: TDS/TCS (Income-tax Act 2025 sections, PAN, thresholds, preview on bills and invoices, quarterly register, challans) and GST reverse charge including import of services; see [`TAX_ENGINE_INDIA_TDS_TCS.md`](TAX_ENGINE_INDIA_TDS_TCS.md). Not started: e-invoicing, payroll, compliance calendars |
| M4 Financial intelligence | Forecasting, budgeting, analytics, AI copilot, alerts, leakage | Not started |
| M5 Autonomous finance | Agent framework, control center, workflow automation, AI reconciliation/collections/close, explainable AI log | Not started |
| M6 Enterprise finance | Multi-entity, consolidation, treasury, fixed assets, advanced reporting, governance | Not started |
| M7 Signature innovations | Digital twin, war room, virtual CFO, recovery planner, knowledge graph, decision memory | Not started |
| M8 Globalisation | Verified country modules, i18n, regional deployment | Not started |
| M9 Commercial SaaS | Subscription billing, plan enforcement, super admin, support, metering, observability, pipelines | Not started |

## Next priorities (proposed order)

1. **M1 hardening:** ~~refresh tokens + logout, rate limiting on auth, PostgreSQL row-level security as a second tenant-isolation layer~~ (done), financial dimension masters, recurring journal templates, year-end close to retained earnings.
2. **M0 remainder:** competitive matrix with sourced, dated research; AI architecture (gateway with mock adapters); design system spec.
3. **M2 depth:** multi-step approval chains, approvals for payments, batch reimbursements, mileage and per-diem claims, expense policies, OFX import, transfers between own accounts.

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
