MASTER DEVELOPMENT DIRECTIVE
SAMPLEDGE TALK2TAX
The AI-Native Global Financial Operating System
Project Codename: TALK2TAX INFINITY
Version: 1.0 — Greenfield Enterprise SaaS Build
PART 1 — YOUR ROLE AND PRIMARY MISSION
You are acting as an elite multidisciplinary software engineering and product development organization.
Assume the responsibilities of:

* Chief Technology Officer
* Chief Product Officer
* Enterprise SaaS Architect
* Principal Full-Stack Engineer
* Financial Systems Architect
* Chartered Accountant and Accounting Domain Specialist
* International Tax Technology Architect
* AI/ML Systems Architect
* Autonomous Agent Orchestration Engineer
* Banking and Payments Integration Architect
* Cybersecurity Architect
* Enterprise UI/UX Design Director
* Advanced Data Visualization Engineer
* Database Architect
* DevOps and Cloud Infrastructure Engineer
* Quality Assurance and Automation Architect
* SaaS Monetization Strategist

Your assignment is to design and implement a completely new, production-oriented, globally scalable platform named:
SAMPLEDGE TALK2TAX
Brand positioning:
"Talk to Your Numbers. Automate Your Finance. Predict Your Future."
Product category:
AI-Native Accounting, Taxation, Treasury, Financial Management, Enterprise Resource Planning, Financial Intelligence and Autonomous Finance SaaS.
PRIMARY OBJECTIVE
Create an exceptionally advanced financial operating system that combines the strongest accounting, finance, tax, payroll, procurement, expense management, enterprise reporting, automation and AI capabilities of the world's leading financial software platforms.
The platform must also introduce innovative capabilities that improve upon fragmented, expensive or difficult-to-use existing systems.
The product must be:

1. Comprehensive.
2. AI-native.
3. Financially accurate.
4. Secure.
5. Highly automated.
6. Internationally scalable.
7. Visually exceptional.
8. Intuitive for non-accountants.
9. Powerful enough for professional accountants and CFOs.
10. Affordable for small businesses.
11. Extensible for large enterprises.
12. Modular and configurable.
13. Accessible across desktop, tablet and mobile.
14. API-first.
15. Auditable and compliant.
16. Designed for continuous innovation.

Do not create a basic accounting application, static dashboard collection, landing page, or superficial prototype.
Build a real application with functional modules, database persistence, APIs, permissions, calculations, business workflows, testing and integration architecture.
Never represent mock data or simulated integrations as real financial activity.
PART 2 — GREENFIELD PROJECT RULES
This is a completely new project.
Do not modify existing Sampledge applications.
Do not assume access to previous repositories, databases, APIs, branding files or deployment environments.
Create a new monorepo named:
sampledge-talk2tax
Use the following application structure:
sampledge-talk2tax/
│
├── apps/
│   ├── web/
│   ├── api/
│   ├── admin/
│   ├── mobile/
│   └── documentation/
│
├── packages/
│   ├── ui/
│   ├── design-system/
│   ├── database/
│   ├── accounting-engine/
│   ├── tax-engine/
│   ├── financial-calculations/
│   ├── ai-orchestration/
│   ├── agent-framework/
│   ├── workflow-engine/
│   ├── integration-sdk/
│   ├── security/
│   ├── analytics/
│   ├── localization/
│   └── shared-types/
│
├── services/
│   ├── accounting/
│   ├── invoicing/
│   ├── payments/
│   ├── treasury/
│   ├── taxation/
│   ├── payroll/
│   ├── procurement/
│   ├── reporting/
│   ├── forecasting/
│   ├── risk/
│   ├── notifications/
│   ├── document-processing/
│   └── integrations/
│
├── infrastructure/
├── database/
├── tests/
├── scripts/
├── docs/
└── README.md
The structure may be refined when justified by architecture, deployment or maintainability requirements.
Prefer a modular monolith initially, with clear domain boundaries and an event-driven design that permits later service extraction.
Do not introduce distributed microservices unnecessarily.
PART 3 — TECHNOLOGY STACK
Frontend
Use:

* Next.js
* React
* TypeScript
* Tailwind CSS
* shadcn/ui
* Radix UI
* Framer Motion / Motion
* GSAP where appropriate
* React Three Fiber
* Three.js
* D3.js
* Apache ECharts
* Recharts
* TanStack Query
* TanStack Table
* React Hook Form
* Zod

Use the latest mutually compatible stable versions.
Backend
Use:

* Node.js
* NestJS
* TypeScript
* REST APIs
* GraphQL where justified
* OpenAPI documentation
* WebSockets or server-sent events
* BullMQ
* Redis
* Temporal or an equivalent durable workflow engine
* Event-driven domain architecture

Data Infrastructure
Use:

* PostgreSQL as the authoritative transactional database.
* Prisma or another well-supported TypeScript ORM.
* Redis for caching and job coordination.
* S3-compatible object storage.
* pgvector or a dedicated vector database where justified.
* OpenSearch or equivalent for enterprise search.
* An analytical data store when transaction volumes justify it.

Use a dedicated, strongly consistent accounting transaction model.
Do not rely on eventually consistent projections as the financial system of record.
AI Infrastructure
Implement a model-agnostic AI gateway supporting configurable providers such as:

* Anthropic Claude
* OpenAI
* Google Gemini
* Other compatible enterprise or self-hosted models

Use appropriate orchestration libraries only when they improve reliability.
Support:

* Model routing.
* Tool calling.
* Structured outputs.
* Retrieval-augmented generation.
* Embeddings.
* Agent-to-agent communication.
* MCP-compatible integrations.
* Model evaluation.
* Prompt versioning.
* Cost tracking.
* AI observability.
* Human approval workflows.
* Model fallback.
* AI permission enforcement.

Do not require paid API keys for the initial local demonstration.
Provide deterministic mock adapters for development.
Real AI functionality must activate through configured providers.
PART 4 — COMPETITIVE CAPABILITY REQUIREMENT
Benchmark the following platforms:

1. QuickBooks Online
2. Xero
3. Zoho Books
4. Oracle NetSuite
5. SAP Cloud ERP
6. Microsoft Dynamics 365 Business Central
7. Sage Intacct
8. FreshBooks
9. Odoo
10. Wave
11. Acumatica
12. Workday Financial Management
13. Ramp
14. BILL
15. TallyPrime

Also benchmark relevant specialized capabilities from:

* Oracle Fusion Cloud Financials
* SAP finance and treasury products
* Microsoft Dynamics 365 Finance
* Workday Adaptive Planning
* Sage AI capabilities
* Enterprise FP&A platforms
* Modern treasury management systems
* Global payroll systems
* Modern procurement systems

COMPETITIVE BENCHMARKING RULE
Before implementing the product, create:
docs/COMPETITIVE_FEATURE_MATRIX.md
For each competitor, document:

* Core accounting features.
* Advanced finance capabilities.
* AI features.
* Automation capabilities.
* Enterprise functionality.
* Payroll.
* Tax.
* Treasury.
* Procurement.
* Reporting.
* Integrations.
* Security.
* Subscription model.
* Limitations.
* Differentiation opportunities.

Classify each capability as:

* Existing and mature.
* Existing but limited.
* Available through add-ons.
* Available through integrations.
* Not confirmed.
* Potentially differentiated.

Do not incorrectly claim that a competitor lacks functionality.
Include official sources and verification dates wherever available.
Do not copy proprietary source code, designs, branding or copyrighted materials.
Build original implementations.
PART 5 — COMPLETE ACCOUNTING ENGINE
Create a full enterprise-grade accounting foundation.
5.1 General Ledger
Implement:

* Double-entry bookkeeping.
* Configurable chart of accounts.
* Hierarchical account structures.
* Account types and subtypes.
* Journal entries.
* Recurring journals.
* Adjusting journals.
* Reversing journals.
* Opening balances.
* Closing balances.
* Journal templates.
* Accrual accounting.
* Cash accounting.
* Multi-period accounting.
* Financial periods.
* Fiscal calendars.
* Period locks.
* Posting controls.
* Audit history.
* Trial balance.
* General ledger reports.
* Subsidiary ledgers.
* Cost centers.
* Profit centers.
* Departments.
* Business units.
* Locations.
* Projects.
* Financial dimensions.
* Custom financial tags.
* Account reconciliation.
* Intercompany accounting.
* Consolidation adjustments.
* Foreign currency revaluation.
* Automated journal suggestions.

Critical accounting invariants
Every posted journal must balance.
Use fixed-precision decimal arithmetic.
Never use binary floating-point arithmetic for monetary calculations.
Store transaction currency, functional currency and applicable exchange rates.
Prevent unauthorized changes to posted entries.
Corrections must use auditable reversal or adjustment entries.
Implement idempotent posting and transaction-level concurrency controls.
Maintain immutable financial posting history.
PART 6 — ACCOUNTS RECEIVABLE
Build a comprehensive AR module.
Include:

* Customer management.
* Customer onboarding.
* Customer credit limits.
* Quotations.
* Estimates.
* Sales orders.
* Pro forma invoices.
* Tax invoices.
* Recurring invoices.
* Subscription billing.
* Usage-based billing.
* Milestone billing.
* Progress billing.
* Retainer billing.
* Credit notes.
* Debit notes.
* Payment links.
* Payment allocation.
* Partial payments.
* Advance payments.
* Customer statements.
* Receivable aging.
* Collection reminders.
* Dispute management.
* Bad debt provisions.
* Write-offs.
* Revenue recognition support.
* Contract billing.
* Customer portals.
* Multi-currency invoices.
* Revenue leakage detection.

Advanced AR AI
Implement:

* Predictive payment-delay scoring.
* Intelligent collection prioritization.
* Automated reminder drafting.
* Customer risk analysis.
* Invoice dispute classification.
* Customer financial behavior analysis.
* Cash collection forecasting.
* Suggested payment plans.
* AI-assisted contract-to-invoice matching.
* Automated detection of unbilled revenue.

All external communication must respect tenant-configured approval and consent policies.
PART 7 — ACCOUNTS PAYABLE
Implement:

* Supplier management.
* Vendor onboarding.
* Purchase invoices.
* Supplier bills.
* Recurring bills.
* Bill approval workflows.
* Payment scheduling.
* Partial payments.
* Advance payments.
* Credit notes.
* Supplier statements.
* Payables aging.
* Vendor portals.
* Payment batches.
* Purchase order matching.
* Goods receipt matching.
* Three-way matching.
* Duplicate invoice detection.
* Supplier tax validation.
* Expense classification.
* Vendor performance tracking.
* Payment reconciliation.
* International payment preparation.
* Vendor risk monitoring.

Advanced AP AI
Add:

* Invoice document extraction.
* AI invoice coding.
* Supplier bank-detail change detection.
* Payment fraud indicators.
* Dynamic discount recommendations.
* Intelligent payment prioritization.
* Invoice anomaly detection.
* Contract compliance checks.
* Supplier negotiation assistance.
* Predictive payment scheduling.
* Automated exception investigation.

AI may prepare payments but must never execute unauthorized fund transfers.
PART 8 — BANKING AND RECONCILIATION
Build:

* Multiple bank account management.
* Bank statement import.
* CSV, OFX, QIF and applicable banking formats.
* Bank feed integration framework.
* Bank reconciliation.
* Transaction matching.
* Transfer detection.
* Deposit matching.
* Payment matching.
* Bank charges.
* Interest accounting.
* Foreign exchange accounting.
* Unreconciled transaction reporting.
* Bank balance monitoring.
* Reconciliation audit history.

AI Enhancements

* Intelligent transaction classification.
* Adaptive matching suggestions.
* Duplicate transaction detection.
* Suspicious transaction monitoring.
* Reconciliation exception analysis.
* Missing transaction identification.
* Cash movement forecasting.
* Unusual bank activity alerts.

Provide a dedicated banking reconciliation workspace.
PART 9 — GLOBAL TAXATION ENGINE
Create a modular, jurisdiction-aware taxation architecture.
Do not hard-code global tax rates.
Use effective-dated, version-controlled rules.
Each country module must include its supported rules, limitations, sources, test cases and maintenance requirements.
India Module
Design for:

* GST.
* CGST.
* SGST.
* IGST.
* UTGST.
* GST invoicing.
* HSN/SAC.
* Input tax credit.
* GST reconciliation.
* GSTR-related reporting.
* E-invoicing.
* E-way bill workflows.
* TDS.
* TCS.
* Income tax preparation support.
* Corporate tax support.
* Advance tax calculations.
* Tax payment tracking.
* Statutory deadline calendars.
* Tax notices.
* Compliance document management.
* Tax audit support.

External government submission must be implemented only through approved and authorized integrations.
Global Tax Modules
Architect for:

* US sales tax.
* US federal and state tax-related reporting.
* UK VAT.
* EU VAT.
* Reverse-charge mechanisms.
* GCC VAT.
* Canadian GST/HST.
* Australian GST.
* Singapore GST.
* Withholding taxes.
* Cross-border tax reporting.
* Country-specific invoice formats.
* Electronic invoicing requirements.

Implement supported jurisdictions incrementally.
Do not claim worldwide compliance without verified, maintained country modules.
AI Tax Intelligence
Include:

* Tax document interpretation.
* Tax discrepancy detection.
* Tax reconciliation.
* Regulatory change monitoring.
* Compliance deadline predictions.
* Tax liability forecasting.
* Tax scenario simulations.
* Tax notice analysis.
* Audit preparation assistance.
* Source-backed tax explanations.

Tax calculations must be performed by deterministic, tested rules.
AI should explain and assist, not invent tax rates or legal requirements.
PART 10 — PAYROLL AND WORKFORCE FINANCE
Build a complete payroll financial management domain.
Include:

* Employee master records.
* Salary structures.
* Payroll calendars.
* Earnings.
* Deductions.
* Bonuses.
* Commissions.
* Reimbursements.
* Overtime.
* Leave-related adjustments.
* Attendance integration.
* Employee advances.
* Loans.
* Benefits accounting.
* Payroll journals.
* Salary payment preparation.
* Payslips.
* Payroll approvals.
* Payroll cost allocation.
* Departmental payroll analysis.
* Project-level labor costs.
* Contractor payments.
* Payroll reporting.

For India, design configurable statutory components covering applicable PF, ESI, professional tax, TDS and other payroll obligations.
Country-specific payroll calculations must be activated only after appropriate regulatory validation.
Payroll AI
Add:

* Payroll anomaly detection.
* Salary cost forecasting.
* Overtime prediction.
* Workforce cost optimization.
* Duplicate payment detection.
* Payroll compliance alerts.
* Employee reimbursement fraud indicators.
* Workforce budget simulations.

PART 11 — PROCUREMENT AND SPEND MANAGEMENT
Implement:

* Purchase requisitions.
* Purchase requests.
* RFQs.
* Supplier quotations.
* Quotation comparison.
* Purchase orders.
* Purchase contracts.
* Approval hierarchies.
* Procurement budgets.
* Goods receipts.
* Service receipts.
* Purchase returns.
* Supplier scorecards.
* Vendor onboarding.
* Contract renewals.
* Procurement analytics.
* Purchase commitments.
* Spend categorization.
* Procurement policy enforcement.
* Budget availability checks.

AI Procurement
Include:

* Supplier recommendations.
* Quote comparison intelligence.
* Spend anomaly detection.
* Contract risk analysis.
* Supplier concentration risk.
* Procurement savings recommendations.
* Purchase demand forecasting.
* Duplicate procurement detection.
* Intelligent sourcing suggestions.
* Contract renewal alerts.

PART 12 — EXPENSE MANAGEMENT
Build a Ramp-style modern expense experience while maintaining original design and implementation.
Include:

* Employee expense submissions.
* Mobile receipt capture.
* OCR.
* Expense categories.
* Mileage claims.
* Travel expenses.
* Per diem.
* Reimbursements.
* Expense approval workflows.
* Corporate card integration architecture.
* Virtual card integration architecture.
* Spending limits.
* Department budgets.
* Policy enforcement.
* Expense reconciliation.
* Expense reporting.
* Duplicate expense detection.
* Receipt-to-transaction matching.

AI Expense Features

* Automatic expense categorization.
* Missing receipt detection.
* Policy violation detection.
* Unusual expense alerts.
* Fraud risk indicators.
* Expense forecasting.
* Intelligent reimbursement routing.
* Automated audit evidence collection.

PART 13 — TREASURY MANAGEMENT
Implement enterprise-grade treasury capabilities.
Include:

* Cash positioning.
* Bank account visibility.
* Cash-flow forecasting.
* Liquidity monitoring.
* Working capital management.
* Cash pooling analysis.
* Intercompany funding.
* Debt management.
* Loan schedules.
* Interest calculations.
* Investment tracking.
* Foreign exchange exposure.
* Currency risk monitoring.
* Payment planning.
* Treasury dashboards.
* Bank relationship management.
* Financing scenarios.
* Debt covenant tracking.

AI Treasury
Include:

* Liquidity shortage prediction.
* Optimal cash allocation suggestions.
* FX exposure alerts.
* Payment timing optimization.
* Debt refinancing scenario analysis.
* Cash reserve recommendations.
* Working capital improvement plans.
* Treasury risk monitoring.

Do not execute investments, borrowing or fund transfers without explicit authorization and applicable regulatory safeguards.
PART 14 — FINANCIAL PLANNING AND ANALYSIS
Create a comprehensive FP&A platform.
Include:

* Annual budgets.
* Quarterly budgets.
* Monthly budgets.
* Rolling forecasts.
* Revenue forecasting.
* Expense forecasting.
* Cash-flow forecasting.
* Headcount planning.
* Department budgets.
* Project budgets.
* Capital expenditure planning.
* Operating expenditure planning.
* Variance analysis.
* Scenario modeling.
* Driver-based planning.
* Sensitivity analysis.
* Break-even analysis.
* Profitability modeling.
* Unit economics.
* Financial KPI management.
* Forecast version control.
* Budget approvals.
* Forecast accuracy monitoring.

Three-Statement Financial Modeling
Create integrated:

1. Income statement.
2. Balance sheet.
3. Cash-flow statement.

Changes to financial assumptions must propagate consistently through all three statements.
Advanced Forecasting
Support:

* 30-day forecasts.
* 60-day forecasts.
* 90-day forecasts.
* 180-day forecasts.
* 365-day forecasts.
* Multi-year strategic forecasts.

Provide confidence intervals and model backtesting.
PART 15 — FINANCIAL DIGITAL TWIN
This must be a signature differentiator.
Create a simulation environment representing an organization's financial structure and operating drivers.
Support:

* Revenue simulations.
* Expense simulations.
* Hiring scenarios.
* Expansion scenarios.
* Product pricing scenarios.
* Tax impact scenarios.
* Debt scenarios.
* Investment scenarios.
* Supplier cost scenarios.
* Customer churn scenarios.
* Currency fluctuations.
* Market downturn scenarios.
* Inflation scenarios.
* Working capital scenarios.

User Experience
The CEO should be able to ask:
"What happens if we expand to five new countries?"
The system should:

1. Identify missing assumptions.
2. Request necessary inputs.
3. Generate scenarios.
4. Estimate financial consequences.
5. Calculate cash requirements.
6. Estimate profitability.
7. Identify key risks.
8. Compare alternatives.
9. Explain assumptions.
10. Save the scenario.

Simulations must remain separate from actual accounting records.
Provide clear visual differentiation between actual, forecast and hypothetical figures.
PART 16 — AI VIRTUAL CFO
Build a sophisticated AI Virtual CFO.
Capabilities:

* Financial health assessment.
* Executive financial summaries.
* Strategic financial recommendations.
* Liquidity analysis.
* Profitability analysis.
* Working capital analysis.
* Revenue growth analysis.
* Cost reduction recommendations.
* Financial risk detection.
* Scenario analysis.
* Board reporting.
* Investor reporting.
* Financial planning assistance.
* Capital allocation analysis.
* Business expansion analysis.
* Debt management analysis.
* Financial benchmarking.

Conversational Interface
Allow questions such as:

* Why did profit decrease?
* Which clients are most profitable?
* Which projects are losing money?
* How much cash will we need next quarter?
* What expenses should we investigate?
* What happens if salaries increase by 10%?
* Which vendors are charging more than expected?
* What is our current tax exposure?
* Which invoices are likely to be paid late?

Every material answer must include:

* Source records.
* Relevant period.
* Calculation method.
* Assumptions.
* Confidence or uncertainty.
* Recommended actions.
* Required approvals.

Never fabricate financial figures.
PART 17 — MULTI-AGENT AI FINANCE WORKFORCE
Create a dedicated AI Agent Control Center.
Required Agents
Accounting Agents

1. General Ledger Agent
2. Journal Entry Agent
3. Bank Reconciliation Agent
4. Month-End Closing Agent
5. Accounting Policy Agent
6. Financial Statement Agent

Tax Agents

7. GST Agent
8. Income Tax Agent
9. TDS Agent
10. Global Tax Agent
11. Compliance Monitoring Agent
12. Tax Audit Agent

Finance Agents

13. Virtual CFO Agent
14. Cash-Flow Forecasting Agent
15. Budget Planning Agent
16. Profitability Agent
17. Working Capital Agent
18. Financial Risk Agent
19. Financial Digital Twin Agent
20. Revenue Leakage Agent

Operations Agents

21. Accounts Payable Agent
22. Accounts Receivable Agent
23. Collections Agent
24. Vendor Management Agent
25. Procurement Agent
26. Expense Audit Agent
27. Payroll Agent
28. Contract Intelligence Agent

Governance Agents

29. Fraud Detection Agent
30. Internal Audit Agent
31. Financial Controls Agent
32. Regulatory Intelligence Agent
33. Security Monitoring Agent
34. AI Quality Assurance Agent

Business Intelligence Agents

35. Executive Reporting Agent
36. Financial Benchmarking Agent
37. Customer Profitability Agent
38. Project Profitability Agent
39. Strategic Planning Agent
40. Business Opportunity Agent

Agent Orchestration
Create a central orchestration layer that:

* Assigns tasks to appropriate agents.
* Coordinates dependencies.
* Enforces permissions.
* Prevents conflicting actions.
* Tracks execution status.
* Maintains task histories.
* Handles retries.
* Escalates exceptions.
* Requires human approvals.
* Records AI decisions.
* Measures accuracy.
* Tracks model costs.

Agent Action Levels
Level 0: Read-only analysis.
Level 1: Draft recommendations.
Level 2: Prepare changes for approval.
Level 3: Execute approved low-risk workflows.
Level 4: Execute specifically authorized actions within strict limits.
High-risk financial activities must require appropriate human authorization regardless of agent confidence.
Provide an emergency stop and tenant-wide AI disable controls.
PART 18 — AUTONOMOUS FINANCIAL WORKFLOWS
Create a visual no-code and low-code workflow automation builder.
Support:

* Trigger-based automation.
* Scheduled automation.
* Event-based automation.
* Conditional branching.
* Approval workflows.
* Parallel tasks.
* Escalations.
* Notifications.
* Document generation.
* API calls.
* Webhooks.
* AI agent actions.
* Retry policies.
* Failure recovery.
* Workflow versioning.
* Workflow testing.
* Execution logs.

Example Automations
Invoice Collection
Invoice becomes overdue → AI assesses risk → Drafts reminder → Checks communication policy → Sends approved reminder → Monitors response → Updates collections dashboard.
Vendor Invoice Processing
Invoice received → Document extracted → Supplier validated → Duplicate check → PO matching → Tax validation → Approval → Ledger posting → Payment scheduling.
Financial Close
Period approaches closing → Reconciliation tasks generated → Missing records identified → Exceptions investigated → Adjustments proposed → Accountant approves → Reports generated → Period locked.
Tax Compliance
Filing deadline approaches → Required records collected → Reconciliation performed → Exceptions highlighted → Tax professional reviews → Filing package prepared → Authorized submission → Confirmation stored.
PART 19 — ENTERPRISE FINANCIAL MANAGEMENT
Include:

* Multi-company accounting.
* Multi-entity accounting.
* Multi-branch management.
* Multi-country organizations.
* Multi-currency accounting.
* Multi-language interfaces.
* Consolidated financial statements.
* Intercompany transactions.
* Intercompany elimination.
* Minority interest support.
* Foreign currency translation.
* Group reporting.
* Subsidiary reporting.
* Financial dimensions.
* Revenue recognition.
* Deferred revenue.
* Prepaid expenses.
* Accruals.
* Fixed asset management.
* Depreciation.
* Amortization.
* Lease accounting.
* Cost allocation.
* Transfer pricing support.
* Financial controls.
* Audit management.
* Corporate reporting.

Design for configurable accounting frameworks such as IFRS and applicable local GAAP.
Do not claim standards compliance without appropriate validation.
PART 20 — INVENTORY, MANUFACTURING AND SERVICE FINANCE
Implement accounting integration for:

* Inventory valuation.
* Stock movements.
* Inventory adjustments.
* Warehouse accounting.
* Cost of goods sold.
* Purchase returns.
* Sales returns.
* Inventory write-offs.
* Landed costs.
* Batch costing.
* Standard costing.
* Weighted average costing.
* FIFO where supported.
* Manufacturing cost accounting.
* Work-in-progress accounting.
* Bill of materials cost tracking.
* Job costing.
* Service costing.
* Project costing.
* Contract costing.

Provide industry-specific configuration rather than forcing every company into the same workflow.
PART 21 — PROJECT FINANCIAL MANAGEMENT
Create a complete project finance module.
Include:

* Project budgets.
* Project revenue.
* Project expenses.
* Project purchase orders.
* Project vendor payments.
* Project invoicing.
* Milestone billing.
* Time tracking.
* Resource costs.
* Contractor costs.
* Project cash flow.
* Estimated profitability.
* Actual profitability.
* Cost overruns.
* Revenue leakage.
* Budget alerts.
* Project financial forecasting.
* Project closure accounting.

Special Market Research Industry Template
Provide optional workflows for:

* Research project quotations.
* Sample supplier budgets.
* Cost per interview.
* Cost per complete.
* Survey programming expenses.
* Data processing expenses.
* Panel incentive costs.
* Vendor allocations.
* Client billing milestones.
* Project margin analysis.
* Currency exposure.
* Supplier payment tracking.

This must be an optional industry template.
Talk2Tax must remain an independent product and must not require Sampledge marketplace integrations.
PART 22 — CRM AND FINANCE INTEGRATION
Provide native lightweight CRM functionality and integration APIs for external CRM systems.
Include:

* Customer records.
* Leads.
* Opportunities.
* Quotations.
* Contracts.
* Sales orders.
* Billing.
* Collections.
* Customer profitability.
* Customer lifetime value.
* Credit risk.
* Revenue forecasting.

Support the complete:
Lead → Quote → Contract → Order → Invoice → Payment → Profitability
workflow.
PART 23 — FINANCIAL FRAUD AND RISK INTELLIGENCE
Implement:

* Duplicate invoice detection.
* Suspicious payment monitoring.
* Vendor bank change alerts.
* Unusual journal detection.
* Expense fraud indicators.
* Payroll anomalies.
* Unauthorized access detection.
* Financial control violations.
* Transaction pattern analysis.
* Payment approval anomalies.
* Supplier concentration risk.
* Customer concentration risk.
* Liquidity risk.
* Currency exposure risk.
* Credit risk.
* Operational financial risk.

Use explainable risk scoring.
Provide evidence and reasons for alerts.
Do not automatically accuse individuals of fraud.
PART 24 — CONTINUOUS AUDIT AND GOVERNANCE
Create:

* Internal audit workspace.
* External auditor portal.
* Audit evidence management.
* Audit trails.
* Transaction history.
* Approval history.
* Document versioning.
* Financial control testing.
* Audit sampling.
* Exception tracking.
* Audit findings.
* Remediation workflows.
* Control ownership.
* Segregation-of-duties checks.
* Period-close certification.
* AI action history.
* Financial transaction replay.

Explainable AI Ledger
Every material AI recommendation or action must record:

* Agent identity.
* Model version.
* Prompt or policy version.
* Data sources.
* Proposed action.
* Reasoning summary.
* Approval status.
* Approving user.
* Execution result.
* Timestamp.
* Relevant evidence references.

Do not expose hidden model chain-of-thought.
Store concise, auditable decision explanations instead.
PART 25 — DOCUMENT INTELLIGENCE
Create a secure financial document management system.
Support:

* Invoices.
* Receipts.
* Purchase orders.
* Contracts.
* Bank statements.
* Tax notices.
* Financial statements.
* Payroll documents.
* Audit documents.
* Vendor agreements.
* Loan agreements.
* Compliance certificates.

AI Document Features

* OCR.
* Classification.
* Entity extraction.
* Field validation.
* Duplicate detection.
* Contract clause extraction.
* Invoice matching.
* Semantic search.
* Document summarization.
* Version comparison.
* Financial obligation extraction.
* Document expiration monitoring.

Use confidence thresholds and human review.
Do not silently overwrite extracted financial information.
PART 26 — ADVANCED FINANCIAL REPORTING
Build a professional reporting studio.
Include:

* Profit and loss.
* Balance sheet.
* Cash-flow statement.
* Trial balance.
* General ledger.
* Accounts receivable aging.
* Accounts payable aging.
* Tax reports.
* Payroll reports.
* Expense reports.
* Budget-versus-actual.
* Project profitability.
* Department profitability.
* Customer profitability.
* Vendor spending.
* Cash forecasts.
* Working capital.
* Financial ratios.
* Consolidated statements.
* Audit reports.
* Executive reports.
* Investor reports.
* Board reports.

Reporting Features

* Custom report builder.
* Drag-and-drop metrics.
* Financial dimensions.
* Filters.
* Saved views.
* Report templates.
* Scheduled reports.
* Email delivery.
* PDF exports.
* Excel exports.
* CSV exports.
* Interactive drill-downs.
* Report sharing.
* Permission-based access.
* Report version history.
* AI narrative generation.

All exported numbers must reconcile with authoritative financial records.
PART 27 — EXTRAORDINARY DASHBOARD DESIGN
This is a critical project requirement.
The visual experience must feel like an exceptionally sophisticated enterprise financial intelligence product.
It must be:

* Creative.
* Modern.
* Polished.
* Professional.
* Visually distinctive.
* Fast.
* Accessible.
* Interactive.
* Highly intuitive.
* Data-rich without becoming cluttered.

Design Direction
Create an original visual identity for Sampledge Talk2Tax.
Use a premium palette based on:

* Deep midnight navy.
* Electric cyan.
* Rich indigo.
* Emerald green.
* Soft violet.
* Warm amber for warnings.
* Neutral white and graphite.

Use refined gradients, glass-like surfaces where appropriate, precise typography and subtle depth.
Avoid excessive visual noise.
Advanced Visualization
Use:

* Interactive 3D financial landscapes.
* Animated cash-flow networks.
* Revenue distribution globes.
* Financial relationship graphs.
* Interactive financial scenario surfaces.
* Animated waterfall charts.
* Sankey diagrams.
* Financial heatmaps.
* Treemaps.
* Forecast confidence bands.
* Interactive timelines.
* Drill-down financial charts.
* Department performance visualizations.
* Risk monitoring displays.
* Financial dependency graphs.

Support animated transitions and motion-responsive interactions.
Where stakeholders request "4D visualization," interpret this as interactive 3D information that changes over time, not a misleading claim of literal four-dimensional rendering.
All critical figures must also be available in accurate 2D charts and accessible tables.
Respect reduced-motion preferences.
Required Dashboards
Build dedicated dashboards for:

1. Global Super Admin
2. Tenant Organization Admin
3. CEO
4. CFO
5. Finance Director
6. Financial Controller
7. Accountant
8. Accounts Payable Manager
9. Accounts Receivable Manager
10. Tax Manager
11. Payroll Manager
12. Treasury Manager
13. Procurement Manager
14. Expense Manager
15. Internal Auditor
16. External Auditor
17. Project Finance Manager
18. Department Manager
19. Vendor
20. Customer
21. AI Agent Administrator
22. Financial Risk Officer
23. Compliance Officer
24. Financial Analyst
25. Investor / Board Viewer

Each dashboard must have a unique role-appropriate layout.
Do not simply reuse the same dashboard with different headings.
PART 28 — EXECUTIVE FINANCIAL COMMAND CENTER
The CEO dashboard must be the flagship experience.
Display:

* Total revenue.
* Net profit.
* Gross profit.
* EBITDA.
* Cash balance.
* Cash runway.
* Receivables.
* Payables.
* Operating expenses.
* Working capital.
* Tax liabilities.
* Forecast revenue.
* Forecast profit.
* Financial health score.
* Risk alerts.
* Department performance.
* Business unit performance.
* Top customers.
* Top vendors.
* Project profitability.
* AI recommendations.

Interactive Experience
Allow executives to select:

* Organization.
* Country.
* Business unit.
* Currency.
* Financial period.
* Department.
* Project.
* Customer segment.

All connected visualizations should update consistently.
Provide an AI conversation panel.
Example:
"Talk2Tax, explain why our profitability decreased this quarter."
The system should show:

1. Relevant financial figures.
2. Variance analysis.
3. Contributing factors.
4. Supporting transactions.
5. Recommended investigation.
6. Possible corrective actions.

PART 29 — AI FINANCIAL WAR ROOM
Create an immersive collaborative financial planning environment.
Include:

* Scenario comparison.
* Financial simulations.
* Cash-flow projections.
* Strategic planning boards.
* Risk maps.
* Budget simulations.
* Departmental financial impact.
* Investment scenarios.
* Business expansion scenarios.
* Collaborative annotations.
* Approval workflows.
* Scenario version history.

Provide a split-screen experience:
Left: Assumptions and controls.
Center: Interactive financial model.
Right: AI recommendations, risks and explanations.
Executives should be able to compare multiple scenarios simultaneously.
PART 30 — REVENUE LEAKAGE AND PROFIT OPTIMIZATION
Build a dedicated Revenue Intelligence Engine.
Detect:

* Unbilled work.
* Missed billing milestones.
* Underpriced contracts.
* Duplicate discounts.
* Uncollected charges.
* Expired pricing agreements.
* Incorrect invoice rates.
* Unrecovered project expenses.
* Supplier cost overruns.
* Low-margin customers.
* Unprofitable projects.
* Revenue recognition inconsistencies.

Provide estimated recoverable value.
Every estimate must be supported by identifiable source records and assumptions.
PART 31 — FINANCIAL RECOVERY PLANNER
Create an AI-assisted business financial recovery workspace.
When financial distress indicators appear, generate:

* Cash conservation scenarios.
* Collection acceleration plans.
* Expense reduction options.
* Supplier renegotiation opportunities.
* Financing scenarios.
* Revenue improvement opportunities.
* Operational restructuring simulations.
* Liquidity recovery forecasts.

Display projected outcomes and risks.
Do not execute layoffs, borrowing, contract changes or financial transfers autonomously.
PART 32 — PRIVACY-PRESERVING FINANCIAL BENCHMARKING
Design an opt-in benchmarking network.
Allow organizations to compare selected metrics against aggregated peer groups.
Potential benchmarks:

* Gross margin.
* Net margin.
* Revenue growth.
* Operating expense ratio.
* Days sales outstanding.
* Days payable outstanding.
* Working capital efficiency.
* Revenue per employee.
* Project profitability.
* Cash conversion cycle.

Requirements:

* Explicit customer consent.
* Aggregation thresholds.
* Suppression of small groups.
* No exposure of competitor-specific financial data.
* Privacy-preserving processing.
* Tenant isolation.
* Transparent benchmark methodology.

Do not fabricate benchmark datasets.
Use clearly labeled synthetic data for demonstrations.
PART 33 — INTERNATIONALIZATION
Build:

* Multi-language UI.
* Multi-currency accounting.
* Regional number formats.
* Regional date formats.
* Country-specific tax configurations.
* Country-specific invoice formats.
* Local financial reporting.
* Time-zone awareness.
* Regional document templates.
* Configurable fiscal years.
* Localization framework.
* Right-to-left layout support where needed.

Start with:

* English.
* Hindi.

Architect for later support of additional languages.
Do not equate UI translation with legal or tax localization.
PART 34 — INTEGRATION MARKETPLACE
Create a full integration platform.
Categories:
Banking

* Open banking providers.
* Bank statement feeds.
* Payment initiation providers.
* Bank account verification.
* Banking reconciliation.

Payments

* Stripe.
* PayPal.
* Razorpay.
* Adyen.
* Supported local payment gateways.

Accounting

* QuickBooks.
* Xero.
* Zoho Books.
* Tally-compatible imports.
* NetSuite.
* Dynamics 365.
* Other supported financial systems.

Business

* Salesforce.
* HubSpot.
* Shopify.
* WooCommerce.
* HRMS platforms.
* Payroll platforms.
* CRM platforms.
* Procurement platforms.
* Project management systems.

Productivity

* Microsoft 365.
* Google Workspace.
* Slack.
* Microsoft Teams.
* Email providers.
* Cloud document storage.

AI

* Claude.
* OpenAI.
* Gemini.
* Approved enterprise AI services.

Integration Requirements
Every connector must provide:

* Authentication.
* Scope-based permissions.
* Connection status.
* Data mapping.
* Sync history.
* Retry logic.
* Rate-limit handling.
* Error handling.
* Reconciliation.
* Audit logs.
* Disconnect controls.

Use sandbox adapters where live provider credentials are unavailable.
Never claim an integration is live merely because its interface exists.
PART 35 — SECURITY AND ENTERPRISE GOVERNANCE
Implement:

* Multi-tenant isolation.
* Organization-level access controls.
* Role-based access control.
* Attribute-based access control where appropriate.
* MFA.
* SSO.
* SAML/OIDC architecture.
* Session management.
* Device management.
* Encryption in transit.
* Encryption at rest.
* Secrets management.
* Key rotation.
* Audit logging.
* API authentication.
* Rate limiting.
* Input validation.
* Secure file uploads.
* Malware scanning.
* Data retention policies.
* Backup and recovery.
* Disaster recovery procedures.
* Security event monitoring.
* Vulnerability scanning.
* Dependency scanning.
* Penetration testing preparation.

Build toward relevant security and privacy frameworks, including SOC 2, ISO 27001 and applicable data protection laws.
Do not claim certification without a completed independent assessment.
AI Security
Add:

* Prompt injection defenses.
* Tool permission enforcement.
* Sensitive data redaction.
* AI action logging.
* AI usage controls.
* Model access policies.
* Cross-tenant data leakage tests.
* Human approval gates.
* Agent execution limits.
* AI emergency shutdown.

PART 36 — USER EXPERIENCE AND ONBOARDING
Create an exceptionally smooth onboarding experience.
Onboarding Wizard

1. Create organization.
2. Select country.
3. Select industry.
4. Select business size.
5. Select accounting framework.
6. Configure fiscal year.
7. Configure currency.
8. Import chart of accounts.
9. Import customers.
10. Import vendors.
11. Import opening balances.
12. Connect banking providers.
13. Configure tax settings.
14. Configure team roles.
15. Configure approval policies.
16. Select AI automation preferences.
17. Review setup validation.
18. Activate organization.

AI Onboarding Assistant
Allow the user to describe the business conversationally.
Example:
"We are a consulting company operating in India and the UAE with 30 employees."
The assistant should recommend relevant configuration options.
All recommendations must be reviewed before activation.
PART 37 — ACCOUNTING DATA MIGRATION
Create migration tools for:

* QuickBooks.
* Xero.
* Zoho Books.
* Tally exports.
* Excel.
* CSV.
* Standard accounting import formats.

Include:

* Chart-of-accounts mapping.
* Customer mapping.
* Vendor mapping.
* Opening balance validation.
* Historical transaction import.
* Duplicate detection.
* Tax mapping.
* Currency conversion validation.
* Reconciliation checks.
* Migration preview.
* Rollback for uncommitted imports.
* Migration audit reports.

Never silently alter historical financial data.
PART 38 — SUBSCRIPTION AND MONETIZATION ENGINE
Create a flexible SaaS billing platform.
Suggested Plans
Starter
India: ₹499/month.
Global: $9/month.
Professional
India: ₹1,499/month.
Global: $25/month.
Business AI
India: ₹3,499/month.
Global: $59/month.
Enterprise AI
India: ₹8,999/month.
Global: $149/month.
Corporate Global
Custom pricing.
These are proposed launch prices, not final validated commercial rates.
Build an admin-configurable pricing system.
Billing Capabilities

* Monthly subscriptions.
* Annual subscriptions.
* Free trials.
* Plan upgrades.
* Plan downgrades.
* Add-on modules.
* Usage-based AI credits.
* Document processing quotas.
* User-based licensing.
* Multi-entity add-ons.
* API usage plans.
* Enterprise contracts.
* Coupons.
* Promotional pricing.
* Regional pricing.
* Tax on subscriptions.
* Automated renewals.
* Payment failure handling.
* Dunning workflows.
* Subscription invoices.

Maintain clear distinctions between platform subscription billing and customers' own accounting transactions.
PART 39 — PLATFORM SUPER ADMIN
Create a dedicated SaaS administration application.
Include:

* Tenant management.
* Organization management.
* User management.
* Subscription management.
* Plan management.
* Feature flags.
* AI usage monitoring.
* AI model configuration.
* API usage monitoring.
* Infrastructure monitoring.
* Support ticket management.
* Audit log search.
* Integration health.
* Billing management.
* Product analytics.
* Error monitoring.
* Security alerts.
* System announcements.
* Maintenance controls.

Super Admin access must not automatically grant unrestricted access to tenant financial data.
Implement controlled support access with explicit authorization, logging and expiration.
PART 40 — MOBILE EXPERIENCE
Create a responsive web application first.
Then provide an architecture for dedicated mobile applications.
Mobile workflows must include:

* Dashboard viewing.
* Invoice creation.
* Receipt capture.
* Expense submission.
* Approval management.
* Payment status.
* Financial alerts.
* AI assistant.
* Document uploads.
* Customer statements.
* Vendor payments overview.
* Cash-flow monitoring.

Provide biometric authentication where supported.
Do not store sensitive financial data insecurely on devices.
PART 41 — PERFORMANCE AND SCALABILITY
Design for:

* Thousands of organizations.
* Large transaction volumes.
* Concurrent users.
* Complex reporting.
* AI workload isolation.
* Background processing.
* Regional deployments.
* Horizontal scaling.
* Database partitioning where justified.
* Caching.
* Read replicas.
* Efficient search.
* Asynchronous document processing.

Establish measurable performance budgets.
Example initial targets:

* Typical dashboard interaction under two seconds under defined test conditions.
* Common API reads under 300 milliseconds at the 95th percentile under defined load.
* Financial posting with transactional consistency.
* No cross-tenant data exposure.
* Recoverable background jobs.
* Observable AI execution.

Benchmark before claiming these targets are achieved.
PART 42 — TESTING AND QUALITY ASSURANCE
Build automated testing from the beginning.
Required Tests

* Unit tests.
* Integration tests.
* API tests.
* End-to-end tests.
* Accounting invariant tests.
* Tax calculation tests.
* Multi-currency tests.
* Reconciliation tests.
* Payroll calculation tests.
* Financial reporting tests.
* Permission tests.
* Tenant isolation tests.
* AI agent evaluation tests.
* Prompt injection tests.
* Workflow recovery tests.
* Load tests.
* Accessibility tests.
* Visual regression tests.
* Security tests.

Financial Test Scenarios
Verify:

1. Every journal balances.
2. Reversals preserve history.
3. Closed periods reject unauthorized postings.
4. Currency conversions use the correct rate and precision.
5. Trial balance reconciles.
6. Financial statements reconcile to the ledger.
7. Duplicate requests do not duplicate postings.
8. Concurrent operations preserve accounting consistency.
9. Tax calculations use the correct effective-dated rules.
10. Unauthorized AI agents cannot post entries or initiate payments.

Use deterministic test fixtures.
PART 43 — DEMONSTRATION DATA
Create realistic synthetic demonstration organizations.
Examples:

1. Indian consulting SME.
2. US professional services company.
3. UK trading business.
4. UAE multinational subsidiary.
5. Global manufacturing group.
6. Market research agency.

Include realistic synthetic:

* Customers.
* Vendors.
* Employees.
* Invoices.
* Bills.
* Journal entries.
* Bank transactions.
* Projects.
* Budgets.
* Tax records.
* Financial reports.
* AI recommendations.

Label all demonstration data as synthetic.
Do not imply the figures represent real organizations.
PART 44 — ADDITIONAL DIFFERENTIATING INNOVATIONS
In addition to every feature already specified, design the following:
44.1 Financial Knowledge Graph
Connect customers, contracts, invoices, vendors, projects, payments, journal entries and risks in an explainable relationship graph.
44.2 Financial Decision Memory
Maintain a searchable history of approved management decisions, assumptions, financial outcomes and lessons learned.
44.3 AI Financial Policy Studio
Allow organizations to define financial policies conversationally.
Convert approved policies into testable, version-controlled workflow rules.
44.4 Continuous Financial Health Monitoring
Evaluate financial indicators continuously and provide prioritized alerts.
44.5 Intelligent Financial Task Marketplace
Provide a centralized queue of tasks generated by users, rules and AI agents.
44.6 Financial Data Lineage Explorer
Allow users to trace any reported figure to its originating transactions and documents.
44.7 Cross-Functional Business Impact Engine
Estimate how sales, HR, procurement and operational changes affect financial performance.
44.8 AI Financial Model Evaluation Lab
Compare forecast models against historical outcomes and track accuracy.
44.9 Financial Disaster Simulation
Simulate liquidity shocks, customer defaults, supplier failures and major operational disruptions.
44.10 Business Opportunity Intelligence
Identify potentially profitable growth opportunities based on authorized financial and operational data.
44.11 Intelligent Financial Recovery Planning
Generate evidence-based financial recovery scenarios.
44.12 Voice-Based Financial Assistant
Allow authorized users to ask financial questions by voice.
Require confirmation for sensitive actions.
44.13 AI-Generated Financial Dashboards
Allow users to describe a dashboard in natural language.
Generate a validated dashboard configuration using approved metrics.
44.14 AI Financial Report Designer
Generate report layouts and narrative summaries from user instructions.
44.15 Explainable Financial Benchmarking
Compare company performance with properly anonymized, authorized benchmark datasets.
PART 45 — COMPLETE NAVIGATION STRUCTURE
Create a premium sidebar and global navigation system.
Primary modules:

1. Overview
2. Executive Command Center
3. AI Finance Copilot
4. Accounting
5. General Ledger
6. Accounts Receivable
7. Accounts Payable
8. Banking
9. Reconciliation
10. Taxation
11. Payroll
12. Expenses
13. Procurement
14. Treasury
15. Financial Planning
16. Budgets
17. Forecasting
18. Financial Digital Twin
19. Financial War Room
20. Projects
21. Contracts
22. Customers
23. Vendors
24. Inventory Finance
25. Fixed Assets
26. Multi-Entity Finance
27. Financial Consolidation
28. Reports
29. Business Intelligence
30. Fraud and Risk
31. Compliance
32. Audit
33. Documents
34. AI Agent Workforce
35. Automation Studio
36. Financial Recovery
37. Financial Benchmarking
38. Integrations
39. Subscription Management
40. Organization Settings
41. User Management
42. Security Center
43. Support
44. Super Admin

Use nested navigation and progressive disclosure.
Do not overwhelm users by showing all modules simultaneously.
Allow organizations to enable only the modules relevant to them.
PART 46 — DESIGN SYSTEM REQUIREMENTS
Create a reusable design system.
Components must include:

* Navigation sidebar.
* Command palette.
* Global search.
* Dashboard cards.
* Financial KPI cards.
* Data tables.
* Advanced filters.
* Charts.
* Financial calculators.
* Date selectors.
* Currency selectors.
* Multi-company selectors.
* Approval dialogs.
* AI recommendation cards.
* Agent status indicators.
* Workflow builders.
* Document viewers.
* Notification center.
* Financial alerts.
* Audit timeline.
* Scenario controls.
* Report builders.
* Form components.
* Empty states.
* Loading states.
* Error states.

Motion Design
Use animation to improve comprehension.
Examples:

* Cash movement animation.
* Financial chart transitions.
* Risk alert transitions.
* Workflow execution visualization.
* Agent collaboration visualization.
* Financial scenario updates.
* Interactive drill-down transitions.

Avoid decorative animation that interferes with accounting work.
PART 47 — IMPLEMENTATION METHODOLOGY
Do not attempt to generate the entire platform in one unverified code dump.
Use milestone-based development.
Milestone 0 — Discovery and Architecture
Produce:

* Product requirements document.
* Competitive feature matrix.
* Domain model.
* Architecture decision records.
* Database design.
* API contracts.
* Security architecture.
* AI architecture.
* Design system specification.
* Implementation roadmap.
* Feature dependency map.

Milestone 1 — Functional Foundation
Implement:

* Monorepo.
* Authentication.
* Tenant management.
* Organization onboarding.
* Roles and permissions.
* Database.
* Accounting engine.
* General ledger.
* Chart of accounts.
* Journal posting.
* Basic financial reports.
* Initial dashboard.

Milestone 2 — Core Finance
Implement:

* AR.
* AP.
* Banking.
* Reconciliation.
* Expenses.
* Customers.
* Vendors.
* Document management.
* Approval workflows.

Milestone 3 — Tax and Payroll
Implement validated initial-country tax workflows, payroll finance and compliance calendars.
Milestone 4 — Financial Intelligence
Implement:

* Forecasting.
* Budgeting.
* Financial analytics.
* AI Copilot.
* Financial alerts.
* Revenue leakage detection.

Milestone 5 — Autonomous Finance
Implement:

* AI agent framework.
* Agent control center.
* Workflow automation.
* AI reconciliation.
* AI collections.
* AI closing assistance.
* Explainable AI audit logs.

Milestone 6 — Enterprise Finance
Implement:

* Multi-entity accounting.
* Consolidation.
* Treasury.
* Fixed assets.
* Advanced financial reporting.
* Enterprise governance.

Milestone 7 — Signature Innovations
Implement:

* Financial Digital Twin.
* Financial War Room.
* AI Virtual CFO.
* Financial Recovery Planner.
* Financial Knowledge Graph.
* Financial Decision Memory.

Milestone 8 — Globalization
Implement verified country modules, internationalization and regional deployment capabilities.
Milestone 9 — Commercial SaaS
Implement:

* Subscription billing.
* Plan enforcement.
* Super Admin.
* Customer support.
* Usage metering.
* Production observability.
* Deployment pipelines.

PART 48 — MANDATORY DELIVERABLES
Create the following files:
README.md
 
docs/
  PRODUCT_REQUIREMENTS.md
  COMPETITIVE_FEATURE_MATRIX.md
  FEATURE_INVENTORY.md
  ARCHITECTURE.md
  DATABASE_SCHEMA.md
  ACCOUNTING_ENGINE.md
  TAX_ENGINE.md
  AI_AGENT_ARCHITECTURE.md
  AI_SAFETY_AND_GOVERNANCE.md
  FINANCIAL_DIGITAL_TWIN.md
  WORKFLOW_ENGINE.md
  INTEGRATION_ARCHITECTURE.md
  SECURITY.md
  DESIGN_SYSTEM.md
  DASHBOARD_SPECIFICATIONS.md
  API_DOCUMENTATION.md
  TEST_STRATEGY.md
  DEPLOYMENT.md
  PRICING_STRATEGY.md
  IMPLEMENTATION_ROADMAP.md
  FEATURE_STATUS.md
  KNOWN_LIMITATIONS.md
Provide:

* Actual source code.
* Database migrations.
* Seed data.
* API endpoints.
* Frontend pages.
* Functional navigation.
* Reusable components.
* Working financial calculations.
* Automated tests.
* Environment configuration examples.
* Docker configuration.
* Development scripts.
* Deployment instructions.
* CI/CD configuration.

PART 49 — FEATURE COMPLETENESS TRACKING
This requirement is mandatory.
Create a feature registry containing every capability described in this prompt.
Each feature must have:

* Unique feature ID.
* Module.
* Description.
* Priority.
* Dependencies.
* Database requirements.
* API requirements.
* UI requirements.
* AI requirements.
* Security requirements.
* Test requirements.
* Implementation status.
* Verification evidence.

Allowed statuses:

* Not started.
* Designed.
* Implementing.
* Implemented.
* Tested.
* Integration pending.
* External approval required.
* Blocked.
* Production ready.

Never mark a feature as implemented merely because a page or button exists.
A feature is implemented only when its relevant business logic, persistence, APIs and UI are functional.
A feature is production ready only after its acceptance criteria and required tests pass.
At the end of every milestone, report:

* Completed features.
* Tested features.
* Remaining features.
* Blocked features.
* Known limitations.
* Next implementation priorities.

Do not silently omit any requirement.
PART 50 — ABSOLUTE QUALITY RULES

1. Do not create fake functional buttons.
2. Do not create disconnected dashboards.
3. Do not substitute static cards for implemented business logic.
4. Do not invent financial data in production.
5. Do not claim AI functionality when only a static response exists.
6. Do not claim live banking integration without credentials and provider validation.
7. Do not claim regulatory compliance without verification.
8. Do not use insecure shortcuts.
9. Do not store secrets in source code.
10. Do not bypass tenant permissions.
11. Do not permit unauthorized AI financial actions.
12. Do not use floating-point arithmetic for financial postings.
13. Do not modify historical posted transactions silently.
14. Do not expose financial information across tenants.
15. Do not skip tests for critical accounting functions.
16. Do not conceal incomplete features.
17. Do not implement proprietary competitor code.
18. Do not over-engineer infrastructure unnecessarily.
19. Do not sacrifice financial accuracy for visual effects.
20. Do not prioritize cosmetic completeness over working accounting functionality.

PART 51 — FINAL PRODUCT EXPERIENCE
The finished platform should feel like:

* A professional accountant's complete workspace.
* A CFO's financial intelligence command center.
* A CEO's strategic decision platform.
* A tax professional's compliance assistant.
* A procurement manager's spending control system.
* A treasury manager's liquidity workspace.
* An auditor's evidence and controls platform.
* An enterprise administrator's secure financial operating system.

Users should be able to complete complex financial workflows with minimal friction.
AI should reduce manual effort while preserving transparency, control and accuracy.
The interface should be memorable and distinctive, but every major visualization must communicate useful information.
PART 52 — INITIAL EXECUTION INSTRUCTIONS
Start this project immediately.
Follow this exact sequence:
STEP 1
Inspect the working directory.
Confirm whether a repository already exists.
If the directory is empty, initialize the new Sampledge Talk2Tax monorepo.
Do not modify unrelated projects.
STEP 2
Generate the complete product requirements document.
Include all modules and requirements from this master prompt.
STEP 3
Create the competitive feature matrix and comprehensive feature registry.
Do not omit features.
STEP 4
Design the system architecture, database schema and accounting domain model.
Prioritize accounting correctness and security.
STEP 5
Create the complete visual design system.
Design the premium Talk2Tax interface, including:

* Login.
* Registration.
* Organization onboarding.
* Executive dashboard.
* CFO dashboard.
* Accountant dashboard.
* AI Finance Copilot.
* Accounting workspace.
* Financial Digital Twin.
* AI Agent Control Center.

STEP 6
Implement authentication, tenant isolation, permissions and the accounting foundation.
STEP 7
Implement a fully functional double-entry accounting engine.
STEP 8
Connect the frontend to actual backend APIs and persistent data.
STEP 9
Create realistic synthetic demonstration data.
STEP 10
Run tests and verify financial invariants.
STEP 11
Launch the local development application.
STEP 12
Provide a milestone completion report and continue with the next approved implementation stage.
WORKING RULE
Do not stop after producing architecture documents or screenshots.
Proceed to working code.
However, do not claim the entire platform is complete until every feature has been implemented and verified.
When external credentials, regulatory approvals, commercial accounts or other user-controlled dependencies are required, document them clearly and continue implementing independent modules.
FINAL INSTRUCTION
Build SAMPLEDGE TALK2TAX as an original, enterprise-grade, AI-native financial operating system.
Combine the strongest capabilities of global accounting and financial software with advanced automation, explainable AI, predictive intelligence, intelligent financial workflows, outstanding design and rigorous financial controls.
Make the architecture comprehensive, the user experience exceptional and the implementation genuinely functional.
BEGIN WITH THE GREENFIELD PROJECT SETUP, FEATURE REGISTRY, ARCHITECTURE AND FIRST WORKING ACCOUNTING MODULE.
