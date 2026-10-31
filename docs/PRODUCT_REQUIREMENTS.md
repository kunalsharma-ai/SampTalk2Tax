# Sampledge Talk2Tax — Product Requirements

> "Talk to Your Numbers. Automate Your Finance. Predict Your Future."

Status: v1.0 draft, derived from the Master Development Directive (`docs/MASTER_DIRECTIVE.md`).
Line-item requirements are not repeated here: every one of the **1,343** capabilities and rules in the directive is an entry in [`FEATURE_INVENTORY.md`](FEATURE_INVENTORY.md) / `features/registry.json`, with an ID, priority, milestone, dependencies, requirement notes and status. This document gives the product framing those entries sit inside.

## 1. Problem

Small and mid-sized businesses run finance across a bookkeeping tool, spreadsheets, a separate tax filer, a payroll vendor, an expense app and a bank portal. Enterprise suites solve the fragmentation but are expensive and hard to use. AI features in existing products are mostly bolted on, and rarely show their sources or ask for approval before acting.

## 2. Product goal

One AI-native financial operating system that is (a) financially exact and auditable first, (b) usable by non-accountants, (c) deep enough for accountants and CFOs, and (d) affordable for small businesses while extensible for enterprises.

## 3. Principles (non-negotiable)

1. **Accuracy before automation.** Deterministic, tested code computes every figure, tax and posting. AI explains, drafts and suggests.
2. **The ledger is the system of record.** Strongly consistent PostgreSQL transactions; no eventually-consistent projection is ever authoritative.
3. **Nothing is silently changed.** Posted entries are immutable; corrections are reversals or adjustments; every mutation is in an append-only audit trail.
4. **Humans approve consequential actions.** AI never moves money, files with a government or posts to the ledger without an authorised human approval path.
5. **Honest status.** No fake buttons, static dashboards posing as live data, or compliance claims without verification (Directive Part 50).
6. **Tenant isolation everywhere** — data model, API, search, AI retrieval and logs.

## 4. Users and personas

| Persona | Primary jobs | First milestone served |
|---|---|---|
| Owner / founder (non-accountant) | Understand cash, profit and obligations; approve | M1 (dashboard), M4 (copilot) |
| Accountant / bookkeeper | Chart of accounts, journals, reconciliation, close | **M1** |
| Financial controller / CFO | Close, reporting, controls, forecasting | M1 reports, M4, M6 |
| AR / AP managers | Invoices, collections, bills, payments | M2 |
| Tax manager | GST/VAT/TDS computation, returns preparation | M3 |
| Payroll manager | Payroll runs, statutory components | M3 |
| Treasury / procurement / expense managers | Liquidity, purchasing, spend | M2, M6 |
| Internal / external auditor | Evidence, controls, trails | M1 audit trail, M6 |
| Platform super admin | Tenants, plans, support | M9 |

The directive also requires 25 role-specific dashboards (Part 27); see inventory `DASH-*`.

## 5. Scope by module

Each module below maps to a directive part, a registry prefix and a delivery milestone (see [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md)).

| Part | Module | Registry prefix | Milestone | Summary |
|---|---|---|---|---|
| 5 | General ledger & accounting engine | GL | M1 (core), M6 (intercompany, consolidation, revaluation) | Double entry, CoA, journals, periods, locks, TB, GL reports, dimensions, invariants |
| 6 | Accounts receivable | AR | M2 | Customers, quotes → invoices → receipts, credit notes, aging, collections, AR AI |
| 7 | Accounts payable | AP | M2 | Vendors, bills, approvals, payment batches, 3-way match, duplicate detection |
| 8 | Banking & reconciliation | BANK | M2 | Statement import (CSV/OFX/QIF), matching, reconciliation workspace |
| 9 | Global tax engine | TAX | M3 | Effective-dated rules; India GST/TDS/TCS first; architecture for VAT/GST/sales tax |
| 10 | Payroll & workforce finance | PAY | M3 | Payroll calendars, earnings/deductions, journals; country statutory only after validation |
| 11 | Procurement | PROC | M2–M6 | Requisitions, RFQs, POs, receipts, budgets |
| 12 | Expense management | EXP | M2 | Claims, receipts/OCR, policies, cards architecture |
| 13 | Treasury | TRS | M6 | Cash positioning, forecasting, debt, FX exposure |
| 14 | FP&A | FPA | M4 | Budgets, forecasts, scenarios, three-statement model |
| 15 | Financial digital twin | TWIN | M7 | Simulation sandbox, separate from actuals |
| 16 | AI Virtual CFO | VCFO | M4/M7 | Source-backed answers with period, method, assumptions, confidence |
| 17 | Multi-agent finance workforce | AGENT | M5 | Agent control center, scoped tools, approvals |
| 18 | Autonomous workflows | WFLOW | M2/M5 | Durable approval and automation workflows |
| 19–22 | Enterprise, inventory, projects, CRM | ENT, INV, PROJ, CRM | M6 | Multi-entity, consolidation, costing, project finance |
| 23–24 | Risk, continuous audit | RISK, AUDIT | M4, M6 | Fraud signals, controls, evidence, explainable AI ledger |
| 25 | Document intelligence | DOC | M2 | Capture, extraction, classification with review |
| 26 | Advanced reporting | RPT | M1 (basic), M6 | Statements, management reports, drill-down |
| 27–29 | Dashboards, command center, war room | DASH, CMD, WAR | M1 (initial), M4, M7 | Role dashboards, accessible charts with table fallbacks |
| 30–32 | Leakage, recovery planner, benchmarking | LEAK, RECOV, BENCH | M4, M7 | Profit optimisation, recovery plans, privacy-preserving benchmarks |
| 33 | Internationalisation | I18N | M8 | Languages, formats, country modules |
| 34 | Integration marketplace | INTG | M6 | Connectors with credential vaulting |
| 35 | Security & governance | SEC | M1 onward | Tenancy, RBAC/ABAC, MFA/SSO, encryption, AI security |
| 36 | UX & onboarding | UX | M1 | Onboarding wizard, AI onboarding assistant |
| 37 | Data migration | MIGR | M6 | Imports from other accounting systems |
| 38–39 | Subscriptions, super admin | SUBS, ADMIN | M9 | Plans, metering, platform administration |
| 40–41 | Mobile, performance | MOB, PERF | M8, M9 | Responsive/mobile, performance budgets |
| 42–43 | QA, demo data | QA, DEMO | M1 onward | Test pyramid, invariant tests, clearly synthetic demo tenants |
| 44–46 | Innovations, navigation, design system | INNOV, NAV, DS | M1 (DS/NAV), M7 | |
| 50 | Absolute quality rules | RULE | All | The 20 rules, each tracked |

## 6. Non-functional requirements

* **Correctness:** fixed-precision decimals; balanced postings enforced in code and database; idempotent posting; concurrency-safe numbering and period locks.
* **Security:** see [`SECURITY.md`](SECURITY.md). No secrets in code; OWASP ASVS L2 as the build target; no certification claims without independent assessment.
* **Performance targets (to be benchmarked, not claimed):** dashboard interactions < 2 s; common API reads < 300 ms p95 under defined load (PERF-015/016).
* **Accessibility:** WCAG 2.2 AA; every chart has an accessible table; reduced-motion respected.
* **Auditability:** every mutation recorded with actor, time and data in a hash-chained trail.
* **Portability:** runs locally with Docker/Postgres and no paid API keys; AI uses deterministic mock adapters until a provider is configured.

## 7. Out of scope until verified

* Government filing (GST portal, e-invoicing IRP, e-way bill), live bank feeds, card issuing and payment execution: require authorised provider integrations and credentials (status "External approval required" when reached).
* Country payroll statutory calculations: only after regulatory validation per country.
* Any claim of SOC 2 / ISO 27001 compliance.

## 8. Success measures (first 12 months, proposed)

* Zero ledger-integrity defects (unbalanced or altered posted entries) in production.
* Month-end close for a 50-person SME in under 2 working days.
* ≥ 70% of bank lines auto-matched with human confirmation.
* Every AI answer in the copilot carries sources and period; zero unsourced figures in evaluation sets.

## 9. Open questions for the product owner

1. First launch market: India-first (GST/TDS) is assumed. Confirm.
2. Accounting frameworks to support first (Ind AS / IFRS / US GAAP presentation).
3. Pricing hypotheses for `PRICING_STRATEGY.md`.
4. Which bank-feed and payment providers to integrate first.
