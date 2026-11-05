# Feature inventory

_Generated from `docs/MASTER_DIRECTIVE.md` by `scripts/generate-feature-registry.mjs`. Do not edit by hand; edit `features/status.json` or `features/modules.json` and re-run `pnpm features:generate`._

Total entries: **1343** (1160 capabilities, 183 rules) across 44 modules.

The machine-readable registry with per-feature database, API, UI, AI, security and test requirements is `features/registry.json`.

## Competitive benchmarking

Part 4 · M0 · priority P0 · depends on: none

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| COMP-001 |  | capability | QuickBooks Online | Not started |
| COMP-002 |  | capability | Xero | Not started |
| COMP-003 |  | capability | Zoho Books | Not started |
| COMP-004 |  | capability | Oracle NetSuite | Not started |
| COMP-005 |  | capability | SAP Cloud ERP | Not started |
| COMP-006 |  | capability | Microsoft Dynamics 365 Business Central | Not started |
| COMP-007 |  | capability | Sage Intacct | Not started |
| COMP-008 |  | capability | FreshBooks | Not started |
| COMP-009 |  | capability | Odoo | Not started |
| COMP-010 |  | capability | Wave | Not started |
| COMP-011 |  | capability | Acumatica | Not started |
| COMP-012 |  | capability | Workday Financial Management | Not started |
| COMP-013 |  | capability | Ramp | Not started |
| COMP-014 |  | capability | BILL | Not started |
| COMP-015 |  | capability | TallyPrime | Not started |
| COMP-016 |  | capability | Oracle Fusion Cloud Financials | Not started |
| COMP-017 |  | capability | SAP finance and treasury products | Not started |
| COMP-018 |  | capability | Microsoft Dynamics 365 Finance | Not started |
| COMP-019 |  | capability | Workday Adaptive Planning | Not started |
| COMP-020 |  | capability | Sage AI capabilities | Not started |
| COMP-021 |  | capability | Enterprise FP&A platforms | Not started |
| COMP-022 |  | capability | Modern treasury management systems | Not started |
| COMP-023 |  | capability | Global payroll systems | Not started |
| COMP-024 |  | capability | Modern procurement systems | Not started |
| COMP-025 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Core accounting features | Not started |
| COMP-026 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Advanced finance capabilities | Not started |
| COMP-027 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | AI features | Not started |
| COMP-028 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Automation capabilities | Not started |
| COMP-029 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Enterprise functionality | Not started |
| COMP-030 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Payroll | Not started |
| COMP-031 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Tax | Not started |
| COMP-032 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Treasury | Not started |
| COMP-033 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Procurement | Not started |
| COMP-034 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Reporting | Not started |
| COMP-035 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Integrations | Not started |
| COMP-036 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Security | Not started |
| COMP-037 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Subscription model | Not started |
| COMP-038 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Limitations | Not started |
| COMP-039 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Differentiation opportunities | Not started |
| COMP-040 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Existing and mature | Not started |
| COMP-041 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Existing but limited | Not started |
| COMP-042 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Available through add-ons | Not started |
| COMP-043 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Available through integrations | Not started |
| COMP-044 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Not confirmed | Not started |
| COMP-045 | docs/COMPETITIVE_FEATURE_MATRIX.md | capability | Potentially differentiated | Not started |
| COMP-046 | docs/COMPETITIVE_FEATURE_MATRIX.md | rule | Do not incorrectly claim that a competitor lacks functionality | Not started |
| COMP-047 | docs/COMPETITIVE_FEATURE_MATRIX.md | rule | Include official sources and verification dates wherever available | Not started |
| COMP-048 | docs/COMPETITIVE_FEATURE_MATRIX.md | rule | Do not copy proprietary source code, designs, branding or copyrighted materials | Not started |
| COMP-049 | docs/COMPETITIVE_FEATURE_MATRIX.md | rule | Build original implementations | Not started |

## General ledger and accounting engine

Part 5 · M1 · priority P0 · depends on: SEC, I18N

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| GL-001 |  | rule | Create a full enterprise-grade accounting foundation | Implementing |
| GL-002 | 5.1 General Ledger | capability | Double-entry bookkeeping | Tested |
| GL-003 | 5.1 General Ledger | capability | Configurable chart of accounts | Tested |
| GL-004 | 5.1 General Ledger | capability | Hierarchical account structures | Tested |
| GL-005 | 5.1 General Ledger | capability | Account types and subtypes | Tested |
| GL-006 | 5.1 General Ledger | capability | Journal entries | Tested |
| GL-007 | 5.1 General Ledger | capability | Recurring journals | Not started |
| GL-008 | 5.1 General Ledger | capability | Adjusting journals | Implemented |
| GL-009 | 5.1 General Ledger | capability | Reversing journals | Tested |
| GL-010 | 5.1 General Ledger | capability | Opening balances | Implemented |
| GL-011 | 5.1 General Ledger | capability | Closing balances | Not started |
| GL-012 | 5.1 General Ledger | capability | Journal templates | Not started |
| GL-013 | 5.1 General Ledger | capability | Accrual accounting | Implementing |
| GL-014 | 5.1 General Ledger | capability | Cash accounting | Not started |
| GL-015 | 5.1 General Ledger | capability | Multi-period accounting | Implemented |
| GL-016 | 5.1 General Ledger | capability | Financial periods | Tested |
| GL-017 | 5.1 General Ledger | capability | Fiscal calendars | Implemented |
| GL-018 | 5.1 General Ledger | capability | Period locks | Tested |
| GL-019 | 5.1 General Ledger | capability | Posting controls | Implemented |
| GL-020 | 5.1 General Ledger | capability | Audit history | Tested |
| GL-021 | 5.1 General Ledger | capability | Trial balance | Tested |
| GL-022 | 5.1 General Ledger | capability | General ledger reports | Implemented |
| GL-023 | 5.1 General Ledger | capability | Subsidiary ledgers | Not started |
| GL-024 | 5.1 General Ledger | capability | Cost centers | Implementing |
| GL-025 | 5.1 General Ledger | capability | Profit centers | Not started |
| GL-026 | 5.1 General Ledger | capability | Departments | Tested |
| GL-027 | 5.1 General Ledger | capability | Business units | Not started |
| GL-028 | 5.1 General Ledger | capability | Locations | Not started |
| GL-029 | 5.1 General Ledger | capability | Projects | Tested |
| GL-030 | 5.1 General Ledger | capability | Financial dimensions | Tested |
| GL-031 | 5.1 General Ledger | capability | Custom financial tags | Not started |
| GL-032 | 5.1 General Ledger | capability | Account reconciliation | Implementing |
| GL-033 | 5.1 General Ledger | capability | Intercompany accounting | Not started |
| GL-034 | 5.1 General Ledger | capability | Consolidation adjustments | Not started |
| GL-035 | 5.1 General Ledger | capability | Foreign currency revaluation | Tested |
| GL-036 | 5.1 General Ledger | capability | Automated journal suggestions | Not started |
| GL-037 | Critical accounting invariants | rule | Every posted journal must balance | Tested |
| GL-038 | Critical accounting invariants | rule | Use fixed-precision decimal arithmetic | Tested |
| GL-039 | Critical accounting invariants | rule | Never use binary floating-point arithmetic for monetary calculations | Tested |
| GL-040 | Critical accounting invariants | rule | Store transaction currency, functional currency and applicable exchange rates | Tested |
| GL-041 | Critical accounting invariants | rule | Prevent unauthorized changes to posted entries | Tested |
| GL-042 | Critical accounting invariants | rule | Corrections must use auditable reversal or adjustment entries | Tested |
| GL-043 | Critical accounting invariants | rule | Implement idempotent posting and transaction-level concurrency controls | Tested |
| GL-044 | Critical accounting invariants | rule | Maintain immutable financial posting history | Tested |

## Accounts receivable

Part 6 · M2 · priority P1 · depends on: GL, DOC, WFLOW

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| AR-001 |  | rule | Build a comprehensive AR module | Implementing |
| AR-002 |  | capability | Customer management | Tested |
| AR-003 |  | capability | Customer onboarding | Not started |
| AR-004 |  | capability | Customer credit limits | Tested |
| AR-005 |  | capability | Quotations | Not started |
| AR-006 |  | capability | Estimates | Not started |
| AR-007 |  | capability | Sales orders | Not started |
| AR-008 |  | capability | Pro forma invoices | Not started |
| AR-009 |  | capability | Tax invoices | Tested |
| AR-010 |  | capability | Recurring invoices | Not started |
| AR-011 |  | capability | Subscription billing | Not started |
| AR-012 |  | capability | Usage-based billing | Not started |
| AR-013 |  | capability | Milestone billing | Not started |
| AR-014 |  | capability | Progress billing | Not started |
| AR-015 |  | capability | Retainer billing | Not started |
| AR-016 |  | capability | Credit notes | Tested |
| AR-017 |  | capability | Debit notes | Not started |
| AR-018 |  | capability | Payment links | Not started |
| AR-019 |  | capability | Payment allocation | Tested |
| AR-020 |  | capability | Partial payments | Tested |
| AR-021 |  | capability | Advance payments | Tested |
| AR-022 |  | capability | Customer statements | Tested |
| AR-023 |  | capability | Receivable aging | Tested |
| AR-024 |  | capability | Collection reminders | Integration pending |
| AR-025 |  | capability | Dispute management | Not started |
| AR-026 |  | capability | Bad debt provisions | Not started |
| AR-027 |  | capability | Write-offs | Not started |
| AR-028 |  | capability | Revenue recognition support | Not started |
| AR-029 |  | capability | Contract billing | Not started |
| AR-030 |  | capability | Customer portals | Not started |
| AR-031 |  | capability | Multi-currency invoices | Not started |
| AR-032 |  | capability | Revenue leakage detection | Tested |
| AR-033 | Advanced AR AI | capability | Predictive payment-delay scoring | Not started |
| AR-034 | Advanced AR AI | capability | Intelligent collection prioritization | Not started |
| AR-035 | Advanced AR AI | capability | Automated reminder drafting | Integration pending |
| AR-036 | Advanced AR AI | capability | Customer risk analysis | Not started |
| AR-037 | Advanced AR AI | capability | Invoice dispute classification | Not started |
| AR-038 | Advanced AR AI | capability | Customer financial behavior analysis | Not started |
| AR-039 | Advanced AR AI | capability | Cash collection forecasting | Not started |
| AR-040 | Advanced AR AI | capability | Suggested payment plans | Not started |
| AR-041 | Advanced AR AI | capability | AI-assisted contract-to-invoice matching | Not started |
| AR-042 | Advanced AR AI | capability | Automated detection of unbilled revenue | Not started |
| AR-043 | Advanced AR AI | rule | All external communication must respect tenant-configured approval and consent policies | Not started |

## Accounts payable

Part 7 · M2 · priority P1 · depends on: GL, DOC, WFLOW, PROC

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| AP-001 |  | capability | Supplier management | Tested |
| AP-002 |  | capability | Vendor onboarding | Not started |
| AP-003 |  | capability | Purchase invoices | Tested |
| AP-004 |  | capability | Supplier bills | Tested |
| AP-005 |  | capability | Recurring bills | Not started |
| AP-006 |  | capability | Bill approval workflows | Tested |
| AP-007 |  | capability | Payment scheduling | Not started |
| AP-008 |  | capability | Partial payments | Implemented |
| AP-009 |  | capability | Advance payments | Implemented |
| AP-010 |  | capability | Credit notes | Implemented |
| AP-011 |  | capability | Supplier statements | Implemented |
| AP-012 |  | capability | Payables aging | Tested |
| AP-013 |  | capability | Vendor portals | Not started |
| AP-014 |  | capability | Payment batches | Not started |
| AP-015 |  | capability | Purchase order matching | Not started |
| AP-016 |  | capability | Goods receipt matching | Not started |
| AP-017 |  | capability | Three-way matching | Not started |
| AP-018 |  | capability | Duplicate invoice detection | Tested |
| AP-019 |  | capability | Supplier tax validation | Not started |
| AP-020 |  | capability | Expense classification | Not started |
| AP-021 |  | capability | Vendor performance tracking | Not started |
| AP-022 |  | capability | Payment reconciliation | Tested |
| AP-023 |  | capability | International payment preparation | Not started |
| AP-024 |  | capability | Vendor risk monitoring | Not started |
| AP-025 | Advanced AP AI | capability | Invoice document extraction | Not started |
| AP-026 | Advanced AP AI | capability | AI invoice coding | Not started |
| AP-027 | Advanced AP AI | capability | Supplier bank-detail change detection | Not started |
| AP-028 | Advanced AP AI | capability | Payment fraud indicators | Not started |
| AP-029 | Advanced AP AI | capability | Dynamic discount recommendations | Not started |
| AP-030 | Advanced AP AI | capability | Intelligent payment prioritization | Not started |
| AP-031 | Advanced AP AI | capability | Invoice anomaly detection | Not started |
| AP-032 | Advanced AP AI | capability | Contract compliance checks | Not started |
| AP-033 | Advanced AP AI | capability | Supplier negotiation assistance | Not started |
| AP-034 | Advanced AP AI | capability | Predictive payment scheduling | Not started |
| AP-035 | Advanced AP AI | capability | Automated exception investigation | Not started |
| AP-036 | Advanced AP AI | rule | AI may prepare payments but must never execute unauthorized fund transfers | Not started |

## Banking and reconciliation

Part 8 · M2 · priority P1 · depends on: GL, INTG

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| BANK-001 |  | capability | Multiple bank account management | Tested |
| BANK-002 |  | capability | Bank statement import | Tested |
| BANK-003 |  | capability | CSV, OFX, QIF and applicable banking formats | Implementing |
| BANK-004 |  | capability | Bank feed integration framework | Not started |
| BANK-005 |  | capability | Bank reconciliation | Tested |
| BANK-006 |  | capability | Transaction matching | Tested |
| BANK-007 |  | capability | Transfer detection | Not started |
| BANK-008 |  | capability | Deposit matching | Tested |
| BANK-009 |  | capability | Payment matching | Tested |
| BANK-010 |  | capability | Bank charges | Tested |
| BANK-011 |  | capability | Interest accounting | Implementing |
| BANK-012 |  | capability | Foreign exchange accounting | Not started |
| BANK-013 |  | capability | Unreconciled transaction reporting | Tested |
| BANK-014 |  | capability | Bank balance monitoring | Implementing |
| BANK-015 |  | capability | Reconciliation audit history | Tested |
| BANK-016 | AI Enhancements | capability | Intelligent transaction classification | Integration pending |
| BANK-017 | AI Enhancements | capability | Adaptive matching suggestions | Implementing |
| BANK-018 | AI Enhancements | capability | Duplicate transaction detection | Tested |
| BANK-019 | AI Enhancements | capability | Suspicious transaction monitoring | Not started |
| BANK-020 | AI Enhancements | capability | Reconciliation exception analysis | Not started |
| BANK-021 | AI Enhancements | capability | Missing transaction identification | Implementing |
| BANK-022 | AI Enhancements | capability | Cash movement forecasting | Not started |
| BANK-023 | AI Enhancements | capability | Unusual bank activity alerts | Not started |
| BANK-024 | AI Enhancements | rule | Provide a dedicated banking reconciliation workspace | Tested |

## Global taxation engine

Part 9 · M3 · priority P1 · depends on: GL, AR, AP

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| TAX-001 |  | rule | Create a modular, jurisdiction-aware taxation architecture | Implementing |
| TAX-002 |  | rule | Do not hard-code global tax rates | Tested |
| TAX-003 |  | rule | Use effective-dated, version-controlled rules | Not started |
| TAX-004 |  | rule | Each country module must include its supported rules, limitations, sources, test cases and maintenance requirements | Tested |
| TAX-005 | India Module | capability | GST | Tested |
| TAX-006 | India Module | capability | CGST | Tested |
| TAX-007 | India Module | capability | SGST | Tested |
| TAX-008 | India Module | capability | IGST | Tested |
| TAX-009 | India Module | capability | UTGST | Tested |
| TAX-010 | India Module | capability | GST invoicing | Tested |
| TAX-011 | India Module | capability | HSN/SAC | Tested |
| TAX-012 | India Module | capability | Input tax credit | Tested |
| TAX-013 | India Module | capability | GST reconciliation | Tested |
| TAX-014 | India Module | capability | GSTR-related reporting | Tested |
| TAX-015 | India Module | capability | E-invoicing | Tested |
| TAX-016 | India Module | capability | E-way bill workflows | Tested |
| TAX-017 | India Module | capability | TDS | Tested |
| TAX-018 | India Module | capability | TCS | Tested |
| TAX-019 | India Module | capability | Income tax preparation support | Not started |
| TAX-020 | India Module | capability | Corporate tax support | Not started |
| TAX-021 | India Module | capability | Advance tax calculations | Implementing |
| TAX-022 | India Module | capability | Tax payment tracking | Implementing |
| TAX-023 | India Module | capability | Statutory deadline calendars | Tested |
| TAX-024 | India Module | capability | Tax notices | Not started |
| TAX-025 | India Module | capability | Compliance document management | Not started |
| TAX-026 | India Module | capability | Tax audit support | Not started |
| TAX-027 | India Module | rule | External government submission must be implemented only through approved and authorized integrations | Implementing |
| TAX-028 | Global Tax Modules | capability | US sales tax | Not started |
| TAX-029 | Global Tax Modules | capability | US federal and state tax-related reporting | Not started |
| TAX-030 | Global Tax Modules | capability | UK VAT | Not started |
| TAX-031 | Global Tax Modules | capability | EU VAT | Not started |
| TAX-032 | Global Tax Modules | capability | Reverse-charge mechanisms | Not started |
| TAX-033 | Global Tax Modules | capability | GCC VAT | Not started |
| TAX-034 | Global Tax Modules | capability | Canadian GST/HST | Not started |
| TAX-035 | Global Tax Modules | capability | Australian GST | Not started |
| TAX-036 | Global Tax Modules | capability | Singapore GST | Not started |
| TAX-037 | Global Tax Modules | capability | Withholding taxes | Implementing |
| TAX-038 | Global Tax Modules | capability | Cross-border tax reporting | Not started |
| TAX-039 | Global Tax Modules | capability | Country-specific invoice formats | Not started |
| TAX-040 | Global Tax Modules | capability | Electronic invoicing requirements | Not started |
| TAX-041 | Global Tax Modules | rule | Implement supported jurisdictions incrementally | Not started |
| TAX-042 | Global Tax Modules | rule | Do not claim worldwide compliance without verified, maintained country modules | Tested |
| TAX-043 | AI Tax Intelligence | capability | Tax document interpretation | Not started |
| TAX-044 | AI Tax Intelligence | capability | Tax discrepancy detection | Not started |
| TAX-045 | AI Tax Intelligence | capability | Tax reconciliation | Not started |
| TAX-046 | AI Tax Intelligence | capability | Regulatory change monitoring | Not started |
| TAX-047 | AI Tax Intelligence | capability | Compliance deadline predictions | Not started |
| TAX-048 | AI Tax Intelligence | capability | Tax liability forecasting | Not started |
| TAX-049 | AI Tax Intelligence | capability | Tax scenario simulations | Not started |
| TAX-050 | AI Tax Intelligence | capability | Tax notice analysis | Not started |
| TAX-051 | AI Tax Intelligence | capability | Audit preparation assistance | Not started |
| TAX-052 | AI Tax Intelligence | capability | Source-backed tax explanations | Not started |
| TAX-053 | AI Tax Intelligence | rule | Tax calculations must be performed by deterministic, tested rules | Tested |
| TAX-054 | AI Tax Intelligence | rule | AI should explain and assist, not invent tax rates or legal requirements | Not started |

## Payroll and workforce finance

Part 10 · M3 · priority P2 · depends on: GL, TAX, WFLOW

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| PAY-001 |  | rule | Build a complete payroll financial management domain | Implementing |
| PAY-002 |  | capability | Employee master records | Tested |
| PAY-003 |  | capability | Salary structures | Tested |
| PAY-004 |  | capability | Payroll calendars | Implementing |
| PAY-005 |  | capability | Earnings | Tested |
| PAY-006 |  | capability | Deductions | Tested |
| PAY-007 |  | capability | Bonuses | Implementing |
| PAY-008 |  | capability | Commissions | Not started |
| PAY-009 |  | capability | Reimbursements | Implementing |
| PAY-010 |  | capability | Overtime | Not started |
| PAY-011 |  | capability | Leave-related adjustments | Implementing |
| PAY-012 |  | capability | Attendance integration | Not started |
| PAY-013 |  | capability | Employee advances | Not started |
| PAY-014 |  | capability | Loans | Not started |
| PAY-015 |  | capability | Benefits accounting | Not started |
| PAY-016 |  | capability | Payroll journals | Tested |
| PAY-017 |  | capability | Salary payment preparation | Implementing |
| PAY-018 |  | capability | Payslips | Tested |
| PAY-019 |  | capability | Payroll approvals | Not started |
| PAY-020 |  | capability | Payroll cost allocation | Not started |
| PAY-021 |  | capability | Departmental payroll analysis | Not started |
| PAY-022 |  | capability | Project-level labor costs | Not started |
| PAY-023 |  | capability | Contractor payments | Not started |
| PAY-024 |  | capability | Payroll reporting | Not started |
| PAY-025 |  | rule | For India, design configurable statutory components covering applicable PF, ESI, professional tax, TDS and other payroll obligations | Implementing |
| PAY-026 |  | rule | Country-specific payroll calculations must be activated only after appropriate regulatory validation | Implementing |
| PAY-027 | Payroll AI | capability | Payroll anomaly detection | Not started |
| PAY-028 | Payroll AI | capability | Salary cost forecasting | Not started |
| PAY-029 | Payroll AI | capability | Overtime prediction | Not started |
| PAY-030 | Payroll AI | capability | Workforce cost optimization | Not started |
| PAY-031 | Payroll AI | capability | Duplicate payment detection | Not started |
| PAY-032 | Payroll AI | capability | Payroll compliance alerts | Not started |
| PAY-033 | Payroll AI | capability | Employee reimbursement fraud indicators | Not started |
| PAY-034 | Payroll AI | capability | Workforce budget simulations | Not started |

## Procurement and spend management

Part 11 · M2 · priority P2 · depends on: GL, WFLOW

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| PROC-001 |  | capability | Purchase requisitions | Not started |
| PROC-002 |  | capability | Purchase requests | Not started |
| PROC-003 |  | capability | RFQs | Not started |
| PROC-004 |  | capability | Supplier quotations | Not started |
| PROC-005 |  | capability | Quotation comparison | Not started |
| PROC-006 |  | capability | Purchase orders | Not started |
| PROC-007 |  | capability | Purchase contracts | Not started |
| PROC-008 |  | capability | Approval hierarchies | Not started |
| PROC-009 |  | capability | Procurement budgets | Not started |
| PROC-010 |  | capability | Goods receipts | Not started |
| PROC-011 |  | capability | Service receipts | Not started |
| PROC-012 |  | capability | Purchase returns | Not started |
| PROC-013 |  | capability | Supplier scorecards | Not started |
| PROC-014 |  | capability | Vendor onboarding | Not started |
| PROC-015 |  | capability | Contract renewals | Not started |
| PROC-016 |  | capability | Procurement analytics | Not started |
| PROC-017 |  | capability | Purchase commitments | Not started |
| PROC-018 |  | capability | Spend categorization | Not started |
| PROC-019 |  | capability | Procurement policy enforcement | Not started |
| PROC-020 |  | capability | Budget availability checks | Not started |
| PROC-021 | AI Procurement | capability | Supplier recommendations | Not started |
| PROC-022 | AI Procurement | capability | Quote comparison intelligence | Not started |
| PROC-023 | AI Procurement | capability | Spend anomaly detection | Not started |
| PROC-024 | AI Procurement | capability | Contract risk analysis | Not started |
| PROC-025 | AI Procurement | capability | Supplier concentration risk | Not started |
| PROC-026 | AI Procurement | capability | Procurement savings recommendations | Not started |
| PROC-027 | AI Procurement | capability | Purchase demand forecasting | Not started |
| PROC-028 | AI Procurement | capability | Duplicate procurement detection | Not started |
| PROC-029 | AI Procurement | capability | Intelligent sourcing suggestions | Not started |
| PROC-030 | AI Procurement | capability | Contract renewal alerts | Not started |

## Expense management

Part 12 · M2 · priority P1 · depends on: GL, WFLOW, DOC

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| EXP-001 |  | rule | Build a Ramp-style modern expense experience while maintaining original design and implementation | Not started |
| EXP-002 |  | capability | Employee expense submissions | Tested |
| EXP-003 |  | capability | Mobile receipt capture | Implementing |
| EXP-004 |  | capability | OCR | Not started |
| EXP-005 |  | capability | Expense categories | Implemented |
| EXP-006 |  | capability | Mileage claims | Not started |
| EXP-007 |  | capability | Travel expenses | Not started |
| EXP-008 |  | capability | Per diem | Not started |
| EXP-009 |  | capability | Reimbursements | Tested |
| EXP-010 |  | capability | Expense approval workflows | Tested |
| EXP-011 |  | capability | Corporate card integration architecture | Not started |
| EXP-012 |  | capability | Virtual card integration architecture | Not started |
| EXP-013 |  | capability | Spending limits | Not started |
| EXP-014 |  | capability | Department budgets | Not started |
| EXP-015 |  | capability | Policy enforcement | Not started |
| EXP-016 |  | capability | Expense reconciliation | Not started |
| EXP-017 |  | capability | Expense reporting | Implementing |
| EXP-018 |  | capability | Duplicate expense detection | Implemented |
| EXP-019 |  | capability | Receipt-to-transaction matching | Not started |
| EXP-020 | AI Expense Features | capability | Automatic expense categorization | Not started |
| EXP-021 | AI Expense Features | capability | Missing receipt detection | Implemented |
| EXP-022 | AI Expense Features | capability | Policy violation detection | Not started |
| EXP-023 | AI Expense Features | capability | Unusual expense alerts | Not started |
| EXP-024 | AI Expense Features | capability | Fraud risk indicators | Not started |
| EXP-025 | AI Expense Features | capability | Expense forecasting | Not started |
| EXP-026 | AI Expense Features | capability | Intelligent reimbursement routing | Not started |
| EXP-027 | AI Expense Features | capability | Automated audit evidence collection | Not started |

## Treasury management

Part 13 · M6 · priority P2 · depends on: GL, BANK

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| TRS-001 |  | rule | Implement enterprise-grade treasury capabilities | Not started |
| TRS-002 |  | capability | Cash positioning | Implementing |
| TRS-003 |  | capability | Bank account visibility | Not started |
| TRS-004 |  | capability | Cash-flow forecasting | Not started |
| TRS-005 |  | capability | Liquidity monitoring | Not started |
| TRS-006 |  | capability | Working capital management | Not started |
| TRS-007 |  | capability | Cash pooling analysis | Not started |
| TRS-008 |  | capability | Intercompany funding | Not started |
| TRS-009 |  | capability | Debt management | Tested |
| TRS-010 |  | capability | Loan schedules | Tested |
| TRS-011 |  | capability | Interest calculations | Tested |
| TRS-012 |  | capability | Investment tracking | Not started |
| TRS-013 |  | capability | Foreign exchange exposure | Tested |
| TRS-014 |  | capability | Currency risk monitoring | Not started |
| TRS-015 |  | capability | Payment planning | Not started |
| TRS-016 |  | capability | Treasury dashboards | Tested |
| TRS-017 |  | capability | Bank relationship management | Not started |
| TRS-018 |  | capability | Financing scenarios | Not started |
| TRS-019 |  | capability | Debt covenant tracking | Not started |
| TRS-020 | AI Treasury | capability | Liquidity shortage prediction | Not started |
| TRS-021 | AI Treasury | capability | Optimal cash allocation suggestions | Not started |
| TRS-022 | AI Treasury | capability | FX exposure alerts | Not started |
| TRS-023 | AI Treasury | capability | Payment timing optimization | Not started |
| TRS-024 | AI Treasury | capability | Debt refinancing scenario analysis | Not started |
| TRS-025 | AI Treasury | capability | Cash reserve recommendations | Not started |
| TRS-026 | AI Treasury | capability | Working capital improvement plans | Not started |
| TRS-027 | AI Treasury | capability | Treasury risk monitoring | Not started |
| TRS-028 | AI Treasury | rule | Do not execute investments, borrowing or fund transfers without explicit authorization and applicable regulatory safeguards | Not started |

## Financial planning and analysis

Part 14 · M4 · priority P2 · depends on: GL, RPT

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| FPA-001 |  | rule | Create a comprehensive FP&A platform | Not started |
| FPA-002 |  | capability | Annual budgets | Tested |
| FPA-003 |  | capability | Quarterly budgets | Not started |
| FPA-004 |  | capability | Monthly budgets | Tested |
| FPA-005 |  | capability | Rolling forecasts | Not started |
| FPA-006 |  | capability | Revenue forecasting | Not started |
| FPA-007 |  | capability | Expense forecasting | Not started |
| FPA-008 |  | capability | Cash-flow forecasting | Tested |
| FPA-009 |  | capability | Headcount planning | Not started |
| FPA-010 |  | capability | Department budgets | Not started |
| FPA-011 |  | capability | Project budgets | Not started |
| FPA-012 |  | capability | Capital expenditure planning | Not started |
| FPA-013 |  | capability | Operating expenditure planning | Not started |
| FPA-014 |  | capability | Variance analysis | Tested |
| FPA-015 |  | capability | Scenario modeling | Not started |
| FPA-016 |  | capability | Driver-based planning | Not started |
| FPA-017 |  | capability | Sensitivity analysis | Not started |
| FPA-018 |  | capability | Break-even analysis | Not started |
| FPA-019 |  | capability | Profitability modeling | Not started |
| FPA-020 |  | capability | Unit economics | Not started |
| FPA-021 |  | capability | Financial KPI management | Tested |
| FPA-022 |  | capability | Forecast version control | Not started |
| FPA-023 |  | capability | Budget approvals | Tested |
| FPA-024 |  | capability | Forecast accuracy monitoring | Tested |
| FPA-025 | Three-Statement Financial Modeling | capability | Income statement | Not started |
| FPA-026 | Three-Statement Financial Modeling | capability | Balance sheet | Not started |
| FPA-027 | Three-Statement Financial Modeling | capability | Cash-flow statement | Not started |
| FPA-028 | Three-Statement Financial Modeling | rule | Changes to financial assumptions must propagate consistently through all three statements | Not started |
| FPA-029 | Advanced Forecasting | capability | 30-day forecasts | Tested |
| FPA-030 | Advanced Forecasting | capability | 60-day forecasts | Tested |
| FPA-031 | Advanced Forecasting | capability | 90-day forecasts | Tested |
| FPA-032 | Advanced Forecasting | capability | 180-day forecasts | Tested |
| FPA-033 | Advanced Forecasting | capability | 365-day forecasts | Tested |
| FPA-034 | Advanced Forecasting | capability | Multi-year strategic forecasts | Not started |
| FPA-035 | Advanced Forecasting | rule | Provide confidence intervals and model backtesting | Implemented |

## Financial digital twin

Part 15 · M7 · priority P3 · depends on: FPA, AIGW

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| TWIN-001 |  | rule | This must be a signature differentiator | Not started |
| TWIN-002 |  | rule | Create a simulation environment representing an organization's financial structure and operating drivers | Tested |
| TWIN-003 |  | capability | Revenue simulations | Tested |
| TWIN-004 |  | capability | Expense simulations | Tested |
| TWIN-005 |  | capability | Hiring scenarios | Tested |
| TWIN-006 |  | capability | Expansion scenarios | Tested |
| TWIN-007 |  | capability | Product pricing scenarios | Tested |
| TWIN-008 |  | capability | Tax impact scenarios | Tested |
| TWIN-009 |  | capability | Debt scenarios | Tested |
| TWIN-010 |  | capability | Investment scenarios | Tested |
| TWIN-011 |  | capability | Supplier cost scenarios | Tested |
| TWIN-012 |  | capability | Customer churn scenarios | Tested |
| TWIN-013 |  | capability | Currency fluctuations | Tested |
| TWIN-014 |  | capability | Market downturn scenarios | Tested |
| TWIN-015 |  | capability | Inflation scenarios | Tested |
| TWIN-016 |  | capability | Working capital scenarios | Tested |
| TWIN-017 | User Experience | capability | Identify missing assumptions | Tested |
| TWIN-018 | User Experience | capability | Request necessary inputs | Tested |
| TWIN-019 | User Experience | capability | Generate scenarios | Tested |
| TWIN-020 | User Experience | capability | Estimate financial consequences | Tested |
| TWIN-021 | User Experience | capability | Calculate cash requirements | Tested |
| TWIN-022 | User Experience | capability | Estimate profitability | Tested |
| TWIN-023 | User Experience | capability | Identify key risks | Tested |
| TWIN-024 | User Experience | capability | Compare alternatives | Tested |
| TWIN-025 | User Experience | capability | Explain assumptions | Tested |
| TWIN-026 | User Experience | capability | Save the scenario | Tested |
| TWIN-027 | User Experience | rule | Simulations must remain separate from actual accounting records | Tested |
| TWIN-028 | User Experience | rule | Provide clear visual differentiation between actual, forecast and hypothetical figures | Tested |

## AI Virtual CFO

Part 16 · M7 · priority P3 · depends on: RPT, AIGW

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| VCFO-001 |  | rule | Build a sophisticated AI Virtual CFO | Implementing |
| VCFO-002 |  | capability | Financial health assessment | Tested |
| VCFO-003 |  | capability | Executive financial summaries | Integration pending |
| VCFO-004 |  | capability | Strategic financial recommendations | Tested |
| VCFO-005 |  | capability | Liquidity analysis | Tested |
| VCFO-006 |  | capability | Profitability analysis | Tested |
| VCFO-007 |  | capability | Working capital analysis | Tested |
| VCFO-008 |  | capability | Revenue growth analysis | Tested |
| VCFO-009 |  | capability | Cost reduction recommendations | Tested |
| VCFO-010 |  | capability | Financial risk detection | Tested |
| VCFO-011 |  | capability | Scenario analysis | Tested |
| VCFO-012 |  | capability | Board reporting | Tested |
| VCFO-013 |  | capability | Investor reporting | Tested |
| VCFO-014 |  | capability | Financial planning assistance | Tested |
| VCFO-015 |  | capability | Capital allocation analysis | Tested |
| VCFO-016 |  | capability | Business expansion analysis | Tested |
| VCFO-017 |  | capability | Debt management analysis | Tested |
| VCFO-018 |  | capability | Financial benchmarking | Implementing |
| VCFO-019 | Conversational Interface | capability | Why did profit decrease? | Tested |
| VCFO-020 | Conversational Interface | capability | Which clients are most profitable? | Implementing |
| VCFO-021 | Conversational Interface | capability | Which projects are losing money? | Tested |
| VCFO-022 | Conversational Interface | capability | How much cash will we need next quarter? | Tested |
| VCFO-023 | Conversational Interface | capability | What expenses should we investigate? | Tested |
| VCFO-024 | Conversational Interface | capability | What happens if salaries increase by 10%? | Tested |
| VCFO-025 | Conversational Interface | capability | Which vendors are charging more than expected? | Tested |
| VCFO-026 | Conversational Interface | capability | What is our current tax exposure? | Tested |
| VCFO-027 | Conversational Interface | capability | Which invoices are likely to be paid late? | Tested |
| VCFO-028 | Conversational Interface | capability | Source records | Tested |
| VCFO-029 | Conversational Interface | capability | Relevant period | Tested |
| VCFO-030 | Conversational Interface | capability | Calculation method | Tested |
| VCFO-031 | Conversational Interface | capability | Assumptions | Tested |
| VCFO-032 | Conversational Interface | capability | Confidence or uncertainty | Tested |
| VCFO-033 | Conversational Interface | capability | Recommended actions | Tested |
| VCFO-034 | Conversational Interface | capability | Required approvals | Tested |
| VCFO-035 | Conversational Interface | rule | Never fabricate financial figures | Tested |

## Multi-agent AI finance workforce

Part 17 · M5 · priority P3 · depends on: AIGW, WFLOW

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| AGENT-001 |  | rule | Create a dedicated AI Agent Control Center | Tested |
| AGENT-002 | Accounting Agents | capability | General Ledger Agent | Not started |
| AGENT-003 | Accounting Agents | capability | Journal Entry Agent | Not started |
| AGENT-004 | Accounting Agents | capability | Bank Reconciliation Agent | Integration pending |
| AGENT-005 | Accounting Agents | capability | Month-End Closing Agent | Integration pending |
| AGENT-006 | Accounting Agents | capability | Accounting Policy Agent | Not started |
| AGENT-007 | Accounting Agents | capability | Financial Statement Agent | Not started |
| AGENT-008 | Tax Agents | capability | GST Agent | Not started |
| AGENT-009 | Tax Agents | capability | Income Tax Agent | Not started |
| AGENT-010 | Tax Agents | capability | TDS Agent | Not started |
| AGENT-011 | Tax Agents | capability | Global Tax Agent | Not started |
| AGENT-012 | Tax Agents | capability | Compliance Monitoring Agent | Not started |
| AGENT-013 | Tax Agents | capability | Tax Audit Agent | Not started |
| AGENT-014 | Finance Agents | capability | Virtual CFO Agent | Not started |
| AGENT-015 | Finance Agents | capability | Cash-Flow Forecasting Agent | Not started |
| AGENT-016 | Finance Agents | capability | Budget Planning Agent | Not started |
| AGENT-017 | Finance Agents | capability | Profitability Agent | Not started |
| AGENT-018 | Finance Agents | capability | Working Capital Agent | Not started |
| AGENT-019 | Finance Agents | capability | Financial Risk Agent | Not started |
| AGENT-020 | Finance Agents | capability | Financial Digital Twin Agent | Not started |
| AGENT-021 | Finance Agents | capability | Revenue Leakage Agent | Not started |
| AGENT-022 | Operations Agents | capability | Accounts Payable Agent | Not started |
| AGENT-023 | Operations Agents | capability | Accounts Receivable Agent | Not started |
| AGENT-024 | Operations Agents | capability | Collections Agent | Integration pending |
| AGENT-025 | Operations Agents | capability | Vendor Management Agent | Not started |
| AGENT-026 | Operations Agents | capability | Procurement Agent | Not started |
| AGENT-027 | Operations Agents | capability | Expense Audit Agent | Not started |
| AGENT-028 | Operations Agents | capability | Payroll Agent | Not started |
| AGENT-029 | Operations Agents | capability | Contract Intelligence Agent | Not started |
| AGENT-030 | Governance Agents | capability | Fraud Detection Agent | Not started |
| AGENT-031 | Governance Agents | capability | Internal Audit Agent | Not started |
| AGENT-032 | Governance Agents | capability | Financial Controls Agent | Not started |
| AGENT-033 | Governance Agents | capability | Regulatory Intelligence Agent | Not started |
| AGENT-034 | Governance Agents | capability | Security Monitoring Agent | Not started |
| AGENT-035 | Governance Agents | capability | AI Quality Assurance Agent | Not started |
| AGENT-036 | Business Intelligence Agents | capability | Executive Reporting Agent | Not started |
| AGENT-037 | Business Intelligence Agents | capability | Financial Benchmarking Agent | Not started |
| AGENT-038 | Business Intelligence Agents | capability | Customer Profitability Agent | Not started |
| AGENT-039 | Business Intelligence Agents | capability | Project Profitability Agent | Not started |
| AGENT-040 | Business Intelligence Agents | capability | Strategic Planning Agent | Not started |
| AGENT-041 | Business Intelligence Agents | capability | Business Opportunity Agent | Not started |
| AGENT-042 | Agent Orchestration | capability | Assigns tasks to appropriate agents | Not started |
| AGENT-043 | Agent Orchestration | capability | Coordinates dependencies | Not started |
| AGENT-044 | Agent Orchestration | capability | Enforces permissions | Implementing |
| AGENT-045 | Agent Orchestration | capability | Prevents conflicting actions | Not started |
| AGENT-046 | Agent Orchestration | capability | Tracks execution status | Implementing |
| AGENT-047 | Agent Orchestration | capability | Maintains task histories | Not started |
| AGENT-048 | Agent Orchestration | capability | Handles retries | Not started |
| AGENT-049 | Agent Orchestration | capability | Escalates exceptions | Not started |
| AGENT-050 | Agent Orchestration | capability | Requires human approvals | Not started |
| AGENT-051 | Agent Orchestration | capability | Records AI decisions | Not started |
| AGENT-052 | Agent Orchestration | capability | Measures accuracy | Tested |
| AGENT-053 | Agent Orchestration | capability | Tracks model costs | Implementing |
| AGENT-054 | Agent Action Levels | rule | Level 0: Read-only analysis | Tested |
| AGENT-055 | Agent Action Levels | rule | Level 1: Draft recommendations | Not started |
| AGENT-056 | Agent Action Levels | rule | Level 2: Prepare changes for approval | Tested |
| AGENT-057 | Agent Action Levels | rule | Level 3: Execute approved low-risk workflows | Not started |
| AGENT-058 | Agent Action Levels | rule | Level 4: Execute specifically authorized actions within strict limits | Not started |
| AGENT-059 | Agent Action Levels | rule | High-risk financial activities must require appropriate human authorization regardless of agent confidence | Not started |
| AGENT-060 | Agent Action Levels | rule | Provide an emergency stop and tenant-wide AI disable controls | Tested |

## Autonomous financial workflows

Part 18 · M5 · priority P2 · depends on: SEC

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| WFLOW-001 |  | rule | Create a visual no-code and low-code workflow automation builder | Implementing |
| WFLOW-002 |  | capability | Trigger-based automation | Tested |
| WFLOW-003 |  | capability | Scheduled automation | Tested |
| WFLOW-004 |  | capability | Event-based automation | Tested |
| WFLOW-005 |  | capability | Conditional branching | Implementing |
| WFLOW-006 |  | capability | Approval workflows | Implementing |
| WFLOW-007 |  | capability | Parallel tasks | Not started |
| WFLOW-008 |  | capability | Escalations | Not started |
| WFLOW-009 |  | capability | Notifications | Integration pending |
| WFLOW-010 |  | capability | Document generation | Not started |
| WFLOW-011 |  | capability | API calls | Not started |
| WFLOW-012 |  | capability | Webhooks | Tested |
| WFLOW-013 |  | capability | AI agent actions | Not started |
| WFLOW-014 |  | capability | Retry policies | Tested |
| WFLOW-015 |  | capability | Failure recovery | Tested |
| WFLOW-016 |  | capability | Workflow versioning | Tested |
| WFLOW-017 |  | capability | Workflow testing | Tested |
| WFLOW-018 |  | capability | Execution logs | Tested |
| WFLOW-019 | Invoice Collection | rule | Invoice becomes overdue → AI assesses risk → Drafts reminder → Checks communication policy → Sends approved reminder → Monitors response → Updates collections dashboard | Implementing |
| WFLOW-020 | Vendor Invoice Processing | rule | Invoice received → Document extracted → Supplier validated → Duplicate check → PO matching → Tax validation → Approval → Ledger posting → Payment scheduling | Not started |
| WFLOW-021 | Financial Close | rule | Period approaches closing → Reconciliation tasks generated → Missing records identified → Exceptions investigated → Adjustments proposed → Accountant approves → Reports generated → Period locked | Implementing |
| WFLOW-022 | Tax Compliance | rule | Filing deadline approaches → Required records collected → Reconciliation performed → Exceptions highlighted → Tax professional reviews → Filing package prepared → Authorized submission → Confirmation stored | Not started |

## Enterprise financial management

Part 19 · M6 · priority P2 · depends on: GL

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| ENT-001 |  | capability | Multi-company accounting | Tested |
| ENT-002 |  | capability | Multi-entity accounting | Tested |
| ENT-003 |  | capability | Multi-branch management | Not started |
| ENT-004 |  | capability | Multi-country organizations | Not started |
| ENT-005 |  | capability | Multi-currency accounting | Not started |
| ENT-006 |  | capability | Multi-language interfaces | Not started |
| ENT-007 |  | capability | Consolidated financial statements | Tested |
| ENT-008 |  | capability | Intercompany transactions | Tested |
| ENT-009 |  | capability | Intercompany elimination | Tested |
| ENT-010 |  | capability | Minority interest support | Tested |
| ENT-011 |  | capability | Foreign currency translation | Tested |
| ENT-012 |  | capability | Group reporting | Tested |
| ENT-013 |  | capability | Subsidiary reporting | Not started |
| ENT-014 |  | capability | Financial dimensions | Tested |
| ENT-015 |  | capability | Revenue recognition | Not started |
| ENT-016 |  | capability | Deferred revenue | Tested |
| ENT-017 |  | capability | Prepaid expenses | Tested |
| ENT-018 |  | capability | Accruals | Tested |
| ENT-019 |  | capability | Fixed asset management | Tested |
| ENT-020 |  | capability | Depreciation | Tested |
| ENT-021 |  | capability | Amortization | Not started |
| ENT-022 |  | capability | Lease accounting | Not started |
| ENT-023 |  | capability | Cost allocation | Not started |
| ENT-024 |  | capability | Transfer pricing support | Not started |
| ENT-025 |  | capability | Financial controls | Not started |
| ENT-026 |  | capability | Audit management | Not started |
| ENT-027 |  | capability | Corporate reporting | Not started |
| ENT-028 |  | rule | Design for configurable accounting frameworks such as IFRS and applicable local GAAP | Implementing |
| ENT-029 |  | rule | Do not claim standards compliance without appropriate validation | Not started |

## Inventory, manufacturing and service finance

Part 20 · M6 · priority P3 · depends on: GL, PROC

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| INV-001 |  | capability | Inventory valuation | Not started |
| INV-002 |  | capability | Stock movements | Not started |
| INV-003 |  | capability | Inventory adjustments | Not started |
| INV-004 |  | capability | Warehouse accounting | Not started |
| INV-005 |  | capability | Cost of goods sold | Not started |
| INV-006 |  | capability | Purchase returns | Not started |
| INV-007 |  | capability | Sales returns | Not started |
| INV-008 |  | capability | Inventory write-offs | Not started |
| INV-009 |  | capability | Landed costs | Not started |
| INV-010 |  | capability | Batch costing | Not started |
| INV-011 |  | capability | Standard costing | Not started |
| INV-012 |  | capability | Weighted average costing | Not started |
| INV-013 |  | capability | FIFO where supported | Not started |
| INV-014 |  | capability | Manufacturing cost accounting | Not started |
| INV-015 |  | capability | Work-in-progress accounting | Not started |
| INV-016 |  | capability | Bill of materials cost tracking | Not started |
| INV-017 |  | capability | Job costing | Not started |
| INV-018 |  | capability | Service costing | Not started |
| INV-019 |  | capability | Project costing | Not started |
| INV-020 |  | capability | Contract costing | Not started |
| INV-021 |  | rule | Provide industry-specific configuration rather than forcing every company into the same workflow | Not started |

## Project financial management

Part 21 · M6 · priority P3 · depends on: GL

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| PROJ-001 |  | rule | Create a complete project finance module | Not started |
| PROJ-002 |  | capability | Project budgets | Not started |
| PROJ-003 |  | capability | Project revenue | Not started |
| PROJ-004 |  | capability | Project expenses | Not started |
| PROJ-005 |  | capability | Project purchase orders | Not started |
| PROJ-006 |  | capability | Project vendor payments | Not started |
| PROJ-007 |  | capability | Project invoicing | Not started |
| PROJ-008 |  | capability | Milestone billing | Not started |
| PROJ-009 |  | capability | Time tracking | Not started |
| PROJ-010 |  | capability | Resource costs | Not started |
| PROJ-011 |  | capability | Contractor costs | Not started |
| PROJ-012 |  | capability | Project cash flow | Not started |
| PROJ-013 |  | capability | Estimated profitability | Not started |
| PROJ-014 |  | capability | Actual profitability | Not started |
| PROJ-015 |  | capability | Cost overruns | Not started |
| PROJ-016 |  | capability | Revenue leakage | Not started |
| PROJ-017 |  | capability | Budget alerts | Not started |
| PROJ-018 |  | capability | Project financial forecasting | Not started |
| PROJ-019 |  | capability | Project closure accounting | Not started |
| PROJ-020 | Special Market Research Industry Template | capability | Research project quotations | Not started |
| PROJ-021 | Special Market Research Industry Template | capability | Sample supplier budgets | Not started |
| PROJ-022 | Special Market Research Industry Template | capability | Cost per interview | Not started |
| PROJ-023 | Special Market Research Industry Template | capability | Cost per complete | Not started |
| PROJ-024 | Special Market Research Industry Template | capability | Survey programming expenses | Not started |
| PROJ-025 | Special Market Research Industry Template | capability | Data processing expenses | Not started |
| PROJ-026 | Special Market Research Industry Template | capability | Panel incentive costs | Not started |
| PROJ-027 | Special Market Research Industry Template | capability | Vendor allocations | Not started |
| PROJ-028 | Special Market Research Industry Template | capability | Client billing milestones | Not started |
| PROJ-029 | Special Market Research Industry Template | capability | Project margin analysis | Not started |
| PROJ-030 | Special Market Research Industry Template | capability | Currency exposure | Not started |
| PROJ-031 | Special Market Research Industry Template | capability | Supplier payment tracking | Not started |
| PROJ-032 | Special Market Research Industry Template | rule | This must be an optional industry template | Not started |
| PROJ-033 | Special Market Research Industry Template | rule | Talk2Tax must remain an independent product and must not require Sampledge marketplace integrations | Not started |

## CRM and finance integration

Part 22 · M6 · priority P3 · depends on: AR, INTG

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| CRM-001 |  | rule | Provide native lightweight CRM functionality and integration APIs for external CRM systems | Not started |
| CRM-002 |  | capability | Customer records | Not started |
| CRM-003 |  | capability | Leads | Not started |
| CRM-004 |  | capability | Opportunities | Not started |
| CRM-005 |  | capability | Quotations | Not started |
| CRM-006 |  | capability | Contracts | Not started |
| CRM-007 |  | capability | Sales orders | Not started |
| CRM-008 |  | capability | Billing | Not started |
| CRM-009 |  | capability | Collections | Not started |
| CRM-010 |  | capability | Customer profitability | Not started |
| CRM-011 |  | capability | Customer lifetime value | Not started |
| CRM-012 |  | capability | Credit risk | Not started |
| CRM-013 |  | capability | Revenue forecasting | Not started |

## Financial fraud and risk intelligence

Part 23 · M4 · priority P2 · depends on: GL, AP, BANK

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| RISK-001 |  | capability | Duplicate invoice detection | Tested |
| RISK-002 |  | capability | Suspicious payment monitoring | Not started |
| RISK-003 |  | capability | Vendor bank change alerts | Not started |
| RISK-004 |  | capability | Unusual journal detection | Tested |
| RISK-005 |  | capability | Expense fraud indicators | Not started |
| RISK-006 |  | capability | Payroll anomalies | Not started |
| RISK-007 |  | capability | Unauthorized access detection | Not started |
| RISK-008 |  | capability | Financial control violations | Not started |
| RISK-009 |  | capability | Transaction pattern analysis | Not started |
| RISK-010 |  | capability | Payment approval anomalies | Not started |
| RISK-011 |  | capability | Supplier concentration risk | Not started |
| RISK-012 |  | capability | Customer concentration risk | Tested |
| RISK-013 |  | capability | Liquidity risk | Not started |
| RISK-014 |  | capability | Currency exposure risk | Not started |
| RISK-015 |  | capability | Credit risk | Not started |
| RISK-016 |  | capability | Operational financial risk | Not started |
| RISK-017 |  | rule | Use explainable risk scoring | Not started |
| RISK-018 |  | rule | Provide evidence and reasons for alerts | Tested |
| RISK-019 |  | rule | Do not automatically accuse individuals of fraud | Tested |

## Continuous audit and governance

Part 24 · M6 · priority P1 · depends on: GL, SEC

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| AUDIT-001 |  | capability | Internal audit workspace | Not started |
| AUDIT-002 |  | capability | External auditor portal | Not started |
| AUDIT-003 |  | capability | Audit evidence management | Not started |
| AUDIT-004 |  | capability | Audit trails | Tested |
| AUDIT-005 |  | capability | Transaction history | Implemented |
| AUDIT-006 |  | capability | Approval history | Tested |
| AUDIT-007 |  | capability | Document versioning | Not started |
| AUDIT-008 |  | capability | Financial control testing | Not started |
| AUDIT-009 |  | capability | Audit sampling | Not started |
| AUDIT-010 |  | capability | Exception tracking | Tested |
| AUDIT-011 |  | capability | Audit findings | Not started |
| AUDIT-012 |  | capability | Remediation workflows | Not started |
| AUDIT-013 |  | capability | Control ownership | Not started |
| AUDIT-014 |  | capability | Segregation-of-duties checks | Not started |
| AUDIT-015 |  | capability | Period-close certification | Tested |
| AUDIT-016 |  | capability | AI action history | Tested |
| AUDIT-017 |  | capability | Financial transaction replay | Not started |
| AUDIT-018 | Explainable AI Ledger | capability | Agent identity | Not started |
| AUDIT-019 | Explainable AI Ledger | capability | Model version | Tested |
| AUDIT-020 | Explainable AI Ledger | capability | Prompt or policy version | Not started |
| AUDIT-021 | Explainable AI Ledger | capability | Data sources | Not started |
| AUDIT-022 | Explainable AI Ledger | capability | Proposed action | Tested |
| AUDIT-023 | Explainable AI Ledger | capability | Reasoning summary | Tested |
| AUDIT-024 | Explainable AI Ledger | capability | Approval status | Tested |
| AUDIT-025 | Explainable AI Ledger | capability | Approving user | Tested |
| AUDIT-026 | Explainable AI Ledger | capability | Execution result | Tested |
| AUDIT-027 | Explainable AI Ledger | capability | Timestamp | Not started |
| AUDIT-028 | Explainable AI Ledger | capability | Relevant evidence references | Implementing |
| AUDIT-029 | Explainable AI Ledger | rule | Do not expose hidden model chain-of-thought | Not started |
| AUDIT-030 | Explainable AI Ledger | rule | Store concise, auditable decision explanations instead | Not started |

## Document intelligence

Part 25 · M2 · priority P2 · depends on: AIGW

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| DOC-001 |  | rule | Create a secure financial document management system | Implementing |
| DOC-002 |  | capability | Invoices | Tested |
| DOC-003 |  | capability | Receipts | Tested |
| DOC-004 |  | capability | Purchase orders | Not started |
| DOC-005 |  | capability | Contracts | Not started |
| DOC-006 |  | capability | Bank statements | Implementing |
| DOC-007 |  | capability | Tax notices | Not started |
| DOC-008 |  | capability | Financial statements | Not started |
| DOC-009 |  | capability | Payroll documents | Not started |
| DOC-010 |  | capability | Audit documents | Not started |
| DOC-011 |  | capability | Vendor agreements | Not started |
| DOC-012 |  | capability | Loan agreements | Not started |
| DOC-013 |  | capability | Compliance certificates | Not started |
| DOC-014 | AI Document Features | capability | OCR | Not started |
| DOC-015 | AI Document Features | capability | Classification | Not started |
| DOC-016 | AI Document Features | capability | Entity extraction | Not started |
| DOC-017 | AI Document Features | capability | Field validation | Not started |
| DOC-018 | AI Document Features | capability | Duplicate detection | Implementing |
| DOC-019 | AI Document Features | capability | Contract clause extraction | Not started |
| DOC-020 | AI Document Features | capability | Invoice matching | Not started |
| DOC-021 | AI Document Features | capability | Semantic search | Not started |
| DOC-022 | AI Document Features | capability | Document summarization | Not started |
| DOC-023 | AI Document Features | capability | Version comparison | Not started |
| DOC-024 | AI Document Features | capability | Financial obligation extraction | Not started |
| DOC-025 | AI Document Features | capability | Document expiration monitoring | Not started |
| DOC-026 | AI Document Features | rule | Use confidence thresholds and human review | Not started |
| DOC-027 | AI Document Features | rule | Do not silently overwrite extracted financial information | Not started |

## Advanced financial reporting

Part 26 · M6 · priority P1 · depends on: GL

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| RPT-001 |  | rule | Build a professional reporting studio | Not started |
| RPT-002 |  | capability | Profit and loss | Not started |
| RPT-003 |  | capability | Balance sheet | Not started |
| RPT-004 |  | capability | Cash-flow statement | Not started |
| RPT-005 |  | capability | Trial balance | Not started |
| RPT-006 |  | capability | General ledger | Not started |
| RPT-007 |  | capability | Accounts receivable aging | Not started |
| RPT-008 |  | capability | Accounts payable aging | Not started |
| RPT-009 |  | capability | Tax reports | Not started |
| RPT-010 |  | capability | Payroll reports | Not started |
| RPT-011 |  | capability | Expense reports | Not started |
| RPT-012 |  | capability | Budget-versus-actual | Not started |
| RPT-013 |  | capability | Project profitability | Tested |
| RPT-014 |  | capability | Department profitability | Tested |
| RPT-015 |  | capability | Customer profitability | Not started |
| RPT-016 |  | capability | Vendor spending | Not started |
| RPT-017 |  | capability | Cash forecasts | Not started |
| RPT-018 |  | capability | Working capital | Tested |
| RPT-019 |  | capability | Financial ratios | Tested |
| RPT-020 |  | capability | Consolidated statements | Not started |
| RPT-021 |  | capability | Audit reports | Not started |
| RPT-022 |  | capability | Executive reports | Not started |
| RPT-023 |  | capability | Investor reports | Not started |
| RPT-024 |  | capability | Board reports | Tested |
| RPT-025 | Reporting Features | capability | Custom report builder | Not started |
| RPT-026 | Reporting Features | capability | Drag-and-drop metrics | Not started |
| RPT-027 | Reporting Features | capability | Financial dimensions | Tested |
| RPT-028 | Reporting Features | capability | Filters | Not started |
| RPT-029 | Reporting Features | capability | Saved views | Not started |
| RPT-030 | Reporting Features | capability | Report templates | Not started |
| RPT-031 | Reporting Features | capability | Scheduled reports | Not started |
| RPT-032 | Reporting Features | capability | Email delivery | Not started |
| RPT-033 | Reporting Features | capability | PDF exports | Tested |
| RPT-034 | Reporting Features | capability | Excel exports | Tested |
| RPT-035 | Reporting Features | capability | CSV exports | Tested |
| RPT-036 | Reporting Features | capability | Interactive drill-downs | Not started |
| RPT-037 | Reporting Features | capability | Report sharing | Not started |
| RPT-038 | Reporting Features | capability | Permission-based access | Not started |
| RPT-039 | Reporting Features | capability | Report version history | Not started |
| RPT-040 | Reporting Features | capability | AI narrative generation | Not started |
| RPT-041 | Reporting Features | rule | All exported numbers must reconcile with authoritative financial records | Not started |

## Dashboard design

Part 27 · M1 · priority P1 · depends on: RPT, DS

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| DASH-001 |  | rule | This is a critical project requirement | Not started |
| DASH-002 |  | rule | The visual experience must feel like an exceptionally sophisticated enterprise financial intelligence product | Not started |
| DASH-003 |  | capability | Creative | Not started |
| DASH-004 |  | capability | Modern | Not started |
| DASH-005 |  | capability | Polished | Not started |
| DASH-006 |  | capability | Professional | Not started |
| DASH-007 |  | capability | Visually distinctive | Not started |
| DASH-008 |  | capability | Fast | Not started |
| DASH-009 |  | capability | Accessible | Not started |
| DASH-010 |  | capability | Interactive | Not started |
| DASH-011 |  | capability | Highly intuitive | Not started |
| DASH-012 |  | capability | Data-rich without becoming cluttered | Not started |
| DASH-013 | Design Direction | rule | Create an original visual identity for Sampledge Talk2Tax | Implementing |
| DASH-014 | Design Direction | capability | Deep midnight navy | Tested |
| DASH-015 | Design Direction | capability | Electric cyan | Tested |
| DASH-016 | Design Direction | capability | Rich indigo | Tested |
| DASH-017 | Design Direction | capability | Emerald green | Tested |
| DASH-018 | Design Direction | capability | Soft violet | Tested |
| DASH-019 | Design Direction | capability | Warm amber for warnings | Tested |
| DASH-020 | Design Direction | capability | Neutral white and graphite | Tested |
| DASH-021 | Design Direction | rule | Use refined gradients, glass-like surfaces where appropriate, precise typography and subtle depth | Not started |
| DASH-022 | Design Direction | rule | Avoid excessive visual noise | Not started |
| DASH-023 | Advanced Visualization | capability | Interactive 3D financial landscapes | Not started |
| DASH-024 | Advanced Visualization | capability | Animated cash-flow networks | Not started |
| DASH-025 | Advanced Visualization | capability | Revenue distribution globes | Not started |
| DASH-026 | Advanced Visualization | capability | Financial relationship graphs | Not started |
| DASH-027 | Advanced Visualization | capability | Interactive financial scenario surfaces | Not started |
| DASH-028 | Advanced Visualization | capability | Animated waterfall charts | Not started |
| DASH-029 | Advanced Visualization | capability | Sankey diagrams | Not started |
| DASH-030 | Advanced Visualization | capability | Financial heatmaps | Not started |
| DASH-031 | Advanced Visualization | capability | Treemaps | Not started |
| DASH-032 | Advanced Visualization | capability | Forecast confidence bands | Not started |
| DASH-033 | Advanced Visualization | capability | Interactive timelines | Not started |
| DASH-034 | Advanced Visualization | capability | Drill-down financial charts | Not started |
| DASH-035 | Advanced Visualization | capability | Department performance visualizations | Not started |
| DASH-036 | Advanced Visualization | capability | Risk monitoring displays | Not started |
| DASH-037 | Advanced Visualization | capability | Financial dependency graphs | Not started |
| DASH-038 | Advanced Visualization | rule | Support animated transitions and motion-responsive interactions | Not started |
| DASH-039 | Advanced Visualization | rule | Where stakeholders request "4D visualization," interpret this as interactive 3D information that changes over time, not a misleading claim of literal four-dimensional rendering | Not started |
| DASH-040 | Advanced Visualization | rule | All critical figures must also be available in accurate 2D charts and accessible tables | Implementing |
| DASH-041 | Advanced Visualization | rule | Respect reduced-motion preferences | Implemented |
| DASH-042 | Required Dashboards | capability | Global Super Admin | Not started |
| DASH-043 | Required Dashboards | capability | Tenant Organization Admin | Not started |
| DASH-044 | Required Dashboards | capability | CEO | Not started |
| DASH-045 | Required Dashboards | capability | CFO | Not started |
| DASH-046 | Required Dashboards | capability | Finance Director | Not started |
| DASH-047 | Required Dashboards | capability | Financial Controller | Not started |
| DASH-048 | Required Dashboards | capability | Accountant | Not started |
| DASH-049 | Required Dashboards | capability | Accounts Payable Manager | Not started |
| DASH-050 | Required Dashboards | capability | Accounts Receivable Manager | Not started |
| DASH-051 | Required Dashboards | capability | Tax Manager | Not started |
| DASH-052 | Required Dashboards | capability | Payroll Manager | Not started |
| DASH-053 | Required Dashboards | capability | Treasury Manager | Not started |
| DASH-054 | Required Dashboards | capability | Procurement Manager | Not started |
| DASH-055 | Required Dashboards | capability | Expense Manager | Not started |
| DASH-056 | Required Dashboards | capability | Internal Auditor | Not started |
| DASH-057 | Required Dashboards | capability | External Auditor | Not started |
| DASH-058 | Required Dashboards | capability | Project Finance Manager | Not started |
| DASH-059 | Required Dashboards | capability | Department Manager | Not started |
| DASH-060 | Required Dashboards | capability | Vendor | Not started |
| DASH-061 | Required Dashboards | capability | Customer | Not started |
| DASH-062 | Required Dashboards | capability | AI Agent Administrator | Not started |
| DASH-063 | Required Dashboards | capability | Financial Risk Officer | Not started |
| DASH-064 | Required Dashboards | capability | Compliance Officer | Not started |
| DASH-065 | Required Dashboards | capability | Financial Analyst | Not started |
| DASH-066 | Required Dashboards | capability | Investor / Board Viewer | Not started |
| DASH-067 | Required Dashboards | rule | Each dashboard must have a unique role-appropriate layout | Not started |
| DASH-068 | Required Dashboards | rule | Do not simply reuse the same dashboard with different headings | Not started |

## Executive financial command center

Part 28 · M4 · priority P2 · depends on: DASH, RPT

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| CMD-001 |  | rule | The CEO dashboard must be the flagship experience | Not started |
| CMD-002 |  | capability | Total revenue | Not started |
| CMD-003 |  | capability | Net profit | Not started |
| CMD-004 |  | capability | Gross profit | Not started |
| CMD-005 |  | capability | EBITDA | Not started |
| CMD-006 |  | capability | Cash balance | Not started |
| CMD-007 |  | capability | Cash runway | Not started |
| CMD-008 |  | capability | Receivables | Not started |
| CMD-009 |  | capability | Payables | Not started |
| CMD-010 |  | capability | Operating expenses | Not started |
| CMD-011 |  | capability | Working capital | Not started |
| CMD-012 |  | capability | Tax liabilities | Not started |
| CMD-013 |  | capability | Forecast revenue | Not started |
| CMD-014 |  | capability | Forecast profit | Not started |
| CMD-015 |  | capability | Financial health score | Not started |
| CMD-016 |  | capability | Risk alerts | Not started |
| CMD-017 |  | capability | Department performance | Not started |
| CMD-018 |  | capability | Business unit performance | Not started |
| CMD-019 |  | capability | Top customers | Not started |
| CMD-020 |  | capability | Top vendors | Not started |
| CMD-021 |  | capability | Project profitability | Not started |
| CMD-022 |  | capability | AI recommendations | Not started |
| CMD-023 | Interactive Experience | capability | Organization | Not started |
| CMD-024 | Interactive Experience | capability | Country | Not started |
| CMD-025 | Interactive Experience | capability | Business unit | Not started |
| CMD-026 | Interactive Experience | capability | Currency | Not started |
| CMD-027 | Interactive Experience | capability | Financial period | Not started |
| CMD-028 | Interactive Experience | capability | Department | Not started |
| CMD-029 | Interactive Experience | capability | Project | Not started |
| CMD-030 | Interactive Experience | capability | Customer segment | Not started |
| CMD-031 | Interactive Experience | rule | All connected visualizations should update consistently | Not started |
| CMD-032 | Interactive Experience | rule | Provide an AI conversation panel | Not started |
| CMD-033 | Interactive Experience | capability | Relevant financial figures | Not started |
| CMD-034 | Interactive Experience | capability | Variance analysis | Not started |
| CMD-035 | Interactive Experience | capability | Contributing factors | Not started |
| CMD-036 | Interactive Experience | capability | Supporting transactions | Not started |
| CMD-037 | Interactive Experience | capability | Recommended investigation | Not started |
| CMD-038 | Interactive Experience | capability | Possible corrective actions | Not started |

## AI financial war room

Part 29 · M7 · priority P3 · depends on: VCFO

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| WAR-001 |  | rule | Create an immersive collaborative financial planning environment | Implementing |
| WAR-002 |  | capability | Scenario comparison | Tested |
| WAR-003 |  | capability | Financial simulations | Tested |
| WAR-004 |  | capability | Cash-flow projections | Tested |
| WAR-005 |  | capability | Strategic planning boards | Tested |
| WAR-006 |  | capability | Risk maps | Tested |
| WAR-007 |  | capability | Budget simulations | Not started |
| WAR-008 |  | capability | Departmental financial impact | Tested |
| WAR-009 |  | capability | Investment scenarios | Tested |
| WAR-010 |  | capability | Business expansion scenarios | Tested |
| WAR-011 |  | capability | Collaborative annotations | Tested |
| WAR-012 |  | capability | Approval workflows | Tested |
| WAR-013 |  | capability | Scenario version history | Tested |
| WAR-014 |  | rule | Left: Assumptions and controls | Tested |
| WAR-015 |  | rule | Center: Interactive financial model | Tested |
| WAR-016 |  | rule | Right: AI recommendations, risks and explanations | Implementing |
| WAR-017 |  | rule | Executives should be able to compare multiple scenarios simultaneously | Tested |

## Revenue leakage and profit optimization

Part 30 · M4 · priority P3 · depends on: AR, RPT

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| LEAK-001 |  | rule | Build a dedicated Revenue Intelligence Engine | Not started |
| LEAK-002 |  | capability | Unbilled work | Not started |
| LEAK-003 |  | capability | Missed billing milestones | Not started |
| LEAK-004 |  | capability | Underpriced contracts | Not started |
| LEAK-005 |  | capability | Duplicate discounts | Not started |
| LEAK-006 |  | capability | Uncollected charges | Not started |
| LEAK-007 |  | capability | Expired pricing agreements | Not started |
| LEAK-008 |  | capability | Incorrect invoice rates | Not started |
| LEAK-009 |  | capability | Unrecovered project expenses | Not started |
| LEAK-010 |  | capability | Supplier cost overruns | Not started |
| LEAK-011 |  | capability | Low-margin customers | Not started |
| LEAK-012 |  | capability | Unprofitable projects | Not started |
| LEAK-013 |  | capability | Revenue recognition inconsistencies | Not started |
| LEAK-014 |  | rule | Provide estimated recoverable value | Not started |
| LEAK-015 |  | rule | Every estimate must be supported by identifiable source records and assumptions | Not started |

## Financial recovery planner

Part 31 · M7 · priority P3 · depends on: FPA, TWIN

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| RECOV-001 |  | rule | Create an AI-assisted business financial recovery workspace | Implementing |
| RECOV-002 |  | capability | Cash conservation scenarios | Tested |
| RECOV-003 |  | capability | Collection acceleration plans | Tested |
| RECOV-004 |  | capability | Expense reduction options | Tested |
| RECOV-005 |  | capability | Supplier renegotiation opportunities | Tested |
| RECOV-006 |  | capability | Financing scenarios | Tested |
| RECOV-007 |  | capability | Revenue improvement opportunities | Tested |
| RECOV-008 |  | capability | Operational restructuring simulations | Tested |
| RECOV-009 |  | capability | Liquidity recovery forecasts | Tested |
| RECOV-010 |  | rule | Display projected outcomes and risks | Tested |
| RECOV-011 |  | rule | Do not execute layoffs, borrowing, contract changes or financial transfers autonomously | Tested |

## Privacy-preserving financial benchmarking

Part 32 · M7 · priority P3 · depends on: RPT, SEC

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| BENCH-001 |  | rule | Design an opt-in benchmarking network | Tested |
| BENCH-002 |  | rule | Allow organizations to compare selected metrics against aggregated peer groups | Tested |
| BENCH-003 |  | capability | Gross margin | Tested |
| BENCH-004 |  | capability | Net margin | Tested |
| BENCH-005 |  | capability | Revenue growth | Tested |
| BENCH-006 |  | capability | Operating expense ratio | Tested |
| BENCH-007 |  | capability | Days sales outstanding | Tested |
| BENCH-008 |  | capability | Days payable outstanding | Tested |
| BENCH-009 |  | capability | Working capital efficiency | Tested |
| BENCH-010 |  | capability | Revenue per employee | Tested |
| BENCH-011 |  | capability | Project profitability | Tested |
| BENCH-012 |  | capability | Cash conversion cycle | Tested |
| BENCH-013 |  | capability | Explicit customer consent | Tested |
| BENCH-014 |  | capability | Aggregation thresholds | Tested |
| BENCH-015 |  | capability | Suppression of small groups | Tested |
| BENCH-016 |  | capability | No exposure of competitor-specific financial data | Tested |
| BENCH-017 |  | capability | Privacy-preserving processing | Implementing |
| BENCH-018 |  | capability | Tenant isolation | Tested |
| BENCH-019 |  | capability | Transparent benchmark methodology | Tested |
| BENCH-020 |  | rule | Do not fabricate benchmark datasets | Tested |
| BENCH-021 |  | rule | Use clearly labeled synthetic data for demonstrations | Tested |

## Internationalization

Part 33 · M8 · priority P2 · depends on: none

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| I18N-001 |  | capability | Multi-language UI | Implementing |
| I18N-002 |  | capability | Multi-currency accounting | Implementing |
| I18N-003 |  | capability | Regional number formats | Tested |
| I18N-004 |  | capability | Regional date formats | Tested |
| I18N-005 |  | capability | Country-specific tax configurations | Tested |
| I18N-006 |  | capability | Country-specific invoice formats | Tested |
| I18N-007 |  | capability | Local financial reporting | Tested |
| I18N-008 |  | capability | Time-zone awareness | Implementing |
| I18N-009 |  | capability | Regional document templates | Tested |
| I18N-010 |  | capability | Configurable fiscal years | Implemented |
| I18N-011 |  | capability | Localization framework | Tested |
| I18N-012 |  | capability | Right-to-left layout support where needed | Implementing |
| I18N-013 |  | capability | English | Tested |
| I18N-014 |  | capability | Hindi | Implementing |
| I18N-015 |  | rule | Architect for later support of additional languages | Tested |
| I18N-016 |  | rule | Do not equate UI translation with legal or tax localization | Implemented |

## Integration marketplace

Part 34 · M6 · priority P2 · depends on: SEC

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| INTG-001 |  | rule | Create a full integration platform | Not started |
| INTG-002 | Banking | capability | Open banking providers | Not started |
| INTG-003 | Banking | capability | Bank statement feeds | Not started |
| INTG-004 | Banking | capability | Payment initiation providers | Not started |
| INTG-005 | Banking | capability | Bank account verification | Not started |
| INTG-006 | Banking | capability | Banking reconciliation | Not started |
| INTG-007 | Payments | capability | Stripe | Not started |
| INTG-008 | Payments | capability | PayPal | Not started |
| INTG-009 | Payments | capability | Razorpay | Not started |
| INTG-010 | Payments | capability | Adyen | Not started |
| INTG-011 | Payments | capability | Supported local payment gateways | Not started |
| INTG-012 | Accounting | capability | QuickBooks | Not started |
| INTG-013 | Accounting | capability | Xero | Not started |
| INTG-014 | Accounting | capability | Zoho Books | Not started |
| INTG-015 | Accounting | capability | Tally-compatible imports | Not started |
| INTG-016 | Accounting | capability | NetSuite | Not started |
| INTG-017 | Accounting | capability | Dynamics 365 | Not started |
| INTG-018 | Accounting | capability | Other supported financial systems | Not started |
| INTG-019 | Business | capability | Salesforce | Not started |
| INTG-020 | Business | capability | HubSpot | Not started |
| INTG-021 | Business | capability | Shopify | Not started |
| INTG-022 | Business | capability | WooCommerce | Not started |
| INTG-023 | Business | capability | HRMS platforms | Not started |
| INTG-024 | Business | capability | Payroll platforms | Not started |
| INTG-025 | Business | capability | CRM platforms | Not started |
| INTG-026 | Business | capability | Procurement platforms | Not started |
| INTG-027 | Business | capability | Project management systems | Not started |
| INTG-028 | Productivity | capability | Microsoft 365 | Not started |
| INTG-029 | Productivity | capability | Google Workspace | Not started |
| INTG-030 | Productivity | capability | Slack | Not started |
| INTG-031 | Productivity | capability | Microsoft Teams | Not started |
| INTG-032 | Productivity | capability | Email providers | Integration pending |
| INTG-033 | Productivity | capability | Cloud document storage | Not started |
| INTG-034 | AI | capability | Claude | Integration pending |
| INTG-035 | AI | capability | OpenAI | Not started |
| INTG-036 | AI | capability | Gemini | Not started |
| INTG-037 | AI | capability | Approved enterprise AI services | Not started |
| INTG-038 | Integration Requirements | capability | Authentication | Not started |
| INTG-039 | Integration Requirements | capability | Scope-based permissions | Not started |
| INTG-040 | Integration Requirements | capability | Connection status | Tested |
| INTG-041 | Integration Requirements | capability | Data mapping | Not started |
| INTG-042 | Integration Requirements | capability | Sync history | Not started |
| INTG-043 | Integration Requirements | capability | Retry logic | Not started |
| INTG-044 | Integration Requirements | capability | Rate-limit handling | Not started |
| INTG-045 | Integration Requirements | capability | Error handling | Not started |
| INTG-046 | Integration Requirements | capability | Reconciliation | Not started |
| INTG-047 | Integration Requirements | capability | Audit logs | Tested |
| INTG-048 | Integration Requirements | capability | Disconnect controls | Tested |
| INTG-049 | Integration Requirements | rule | Use sandbox adapters where live provider credentials are unavailable | Not started |
| INTG-050 | Integration Requirements | rule | Never claim an integration is live merely because its interface exists | Tested |

## Security and enterprise governance

Part 35 · M1 · priority P0 · depends on: none

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| SEC-001 |  | capability | Multi-tenant isolation | Tested |
| SEC-002 |  | capability | Organization-level access controls | Tested |
| SEC-003 |  | capability | Role-based access control | Tested |
| SEC-004 |  | capability | Attribute-based access control where appropriate | Not started |
| SEC-005 |  | capability | MFA | Not started |
| SEC-006 |  | capability | SSO | Not started |
| SEC-007 |  | capability | SAML/OIDC architecture | Not started |
| SEC-008 |  | capability | Session management | Tested |
| SEC-009 |  | capability | Device management | Implementing |
| SEC-010 |  | capability | Encryption in transit | Not started |
| SEC-011 |  | capability | Encryption at rest | Not started |
| SEC-012 |  | capability | Secrets management | Implementing |
| SEC-013 |  | capability | Key rotation | Not started |
| SEC-014 |  | capability | Audit logging | Tested |
| SEC-015 |  | capability | API authentication | Tested |
| SEC-016 |  | capability | Rate limiting | Tested |
| SEC-017 |  | capability | Input validation | Tested |
| SEC-018 |  | capability | Secure file uploads | Not started |
| SEC-019 |  | capability | Malware scanning | Not started |
| SEC-020 |  | capability | Data retention policies | Not started |
| SEC-021 |  | capability | Backup and recovery | Not started |
| SEC-022 |  | capability | Disaster recovery procedures | Not started |
| SEC-023 |  | capability | Security event monitoring | Not started |
| SEC-024 |  | capability | Vulnerability scanning | Not started |
| SEC-025 |  | capability | Dependency scanning | Not started |
| SEC-026 |  | capability | Penetration testing preparation | Not started |
| SEC-027 |  | rule | Build toward relevant security and privacy frameworks, including SOC 2, ISO 27001 and applicable data protection laws | Not started |
| SEC-028 |  | rule | Do not claim certification without a completed independent assessment | Not started |
| SEC-029 | AI Security | capability | Prompt injection defenses | Not started |
| SEC-030 | AI Security | capability | Tool permission enforcement | Not started |
| SEC-031 | AI Security | capability | Sensitive data redaction | Not started |
| SEC-032 | AI Security | capability | AI action logging | Tested |
| SEC-033 | AI Security | capability | AI usage controls | Tested |
| SEC-034 | AI Security | capability | Model access policies | Not started |
| SEC-035 | AI Security | capability | Cross-tenant data leakage tests | Tested |
| SEC-036 | AI Security | capability | Human approval gates | Implementing |
| SEC-037 | AI Security | capability | Agent execution limits | Not started |
| SEC-038 | AI Security | capability | AI emergency shutdown | Not started |

## User experience and onboarding

Part 36 · M1 · priority P1 · depends on: DS

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| UX-001 |  | rule | Create an exceptionally smooth onboarding experience | Not started |
| UX-002 | Onboarding Wizard | capability | Create organization | Tested |
| UX-003 | Onboarding Wizard | capability | Select country | Tested |
| UX-004 | Onboarding Wizard | capability | Select industry | Not started |
| UX-005 | Onboarding Wizard | capability | Select business size | Not started |
| UX-006 | Onboarding Wizard | capability | Select accounting framework | Not started |
| UX-007 | Onboarding Wizard | capability | Configure fiscal year | Tested |
| UX-008 | Onboarding Wizard | capability | Configure currency | Tested |
| UX-009 | Onboarding Wizard | capability | Import chart of accounts | Not started |
| UX-010 | Onboarding Wizard | capability | Import customers | Not started |
| UX-011 | Onboarding Wizard | capability | Import vendors | Not started |
| UX-012 | Onboarding Wizard | capability | Import opening balances | Not started |
| UX-013 | Onboarding Wizard | capability | Connect banking providers | Not started |
| UX-014 | Onboarding Wizard | capability | Configure tax settings | Not started |
| UX-015 | Onboarding Wizard | capability | Configure team roles | Tested |
| UX-016 | Onboarding Wizard | capability | Configure approval policies | Tested |
| UX-017 | Onboarding Wizard | capability | Select AI automation preferences | Not started |
| UX-018 | Onboarding Wizard | capability | Review setup validation | Not started |
| UX-019 | Onboarding Wizard | capability | Activate organization | Not started |
| UX-020 | AI Onboarding Assistant | rule | Allow the user to describe the business conversationally | Not started |
| UX-021 | AI Onboarding Assistant | rule | The assistant should recommend relevant configuration options | Not started |
| UX-022 | AI Onboarding Assistant | rule | All recommendations must be reviewed before activation | Not started |

## Accounting data migration

Part 37 · M6 · priority P2 · depends on: GL

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| MIGR-001 |  | capability | QuickBooks | Not started |
| MIGR-002 |  | capability | Xero | Not started |
| MIGR-003 |  | capability | Zoho Books | Not started |
| MIGR-004 |  | capability | Tally exports | Not started |
| MIGR-005 |  | capability | Excel | Not started |
| MIGR-006 |  | capability | CSV | Not started |
| MIGR-007 |  | capability | Standard accounting import formats | Not started |
| MIGR-008 |  | capability | Chart-of-accounts mapping | Not started |
| MIGR-009 |  | capability | Customer mapping | Not started |
| MIGR-010 |  | capability | Vendor mapping | Not started |
| MIGR-011 |  | capability | Opening balance validation | Not started |
| MIGR-012 |  | capability | Historical transaction import | Not started |
| MIGR-013 |  | capability | Duplicate detection | Not started |
| MIGR-014 |  | capability | Tax mapping | Not started |
| MIGR-015 |  | capability | Currency conversion validation | Not started |
| MIGR-016 |  | capability | Reconciliation checks | Not started |
| MIGR-017 |  | capability | Migration preview | Not started |
| MIGR-018 |  | capability | Rollback for uncommitted imports | Not started |
| MIGR-019 |  | capability | Migration audit reports | Not started |
| MIGR-020 |  | rule | Never silently alter historical financial data | Not started |

## Subscription and monetization engine

Part 38 · M9 · priority P2 · depends on: SEC

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| SUBS-001 |  | rule | Create a flexible SaaS billing platform | Not started |
| SUBS-002 | Starter | rule | India: ₹499/month | Not started |
| SUBS-003 | Starter | rule | Global: $9/month | Not started |
| SUBS-004 | Professional | rule | India: ₹1,499/month | Not started |
| SUBS-005 | Professional | rule | Global: $25/month | Not started |
| SUBS-006 | Business AI | rule | India: ₹3,499/month | Not started |
| SUBS-007 | Business AI | rule | Global: $59/month | Not started |
| SUBS-008 | Enterprise AI | rule | India: ₹8,999/month | Not started |
| SUBS-009 | Enterprise AI | rule | Global: $149/month | Not started |
| SUBS-010 | Corporate Global | rule | These are proposed launch prices, not final validated commercial rates | Not started |
| SUBS-011 | Corporate Global | rule | Build an admin-configurable pricing system | Not started |
| SUBS-012 | Billing Capabilities | capability | Monthly subscriptions | Not started |
| SUBS-013 | Billing Capabilities | capability | Annual subscriptions | Not started |
| SUBS-014 | Billing Capabilities | capability | Free trials | Not started |
| SUBS-015 | Billing Capabilities | capability | Plan upgrades | Not started |
| SUBS-016 | Billing Capabilities | capability | Plan downgrades | Not started |
| SUBS-017 | Billing Capabilities | capability | Add-on modules | Not started |
| SUBS-018 | Billing Capabilities | capability | Usage-based AI credits | Not started |
| SUBS-019 | Billing Capabilities | capability | Document processing quotas | Not started |
| SUBS-020 | Billing Capabilities | capability | User-based licensing | Not started |
| SUBS-021 | Billing Capabilities | capability | Multi-entity add-ons | Not started |
| SUBS-022 | Billing Capabilities | capability | API usage plans | Not started |
| SUBS-023 | Billing Capabilities | capability | Enterprise contracts | Not started |
| SUBS-024 | Billing Capabilities | capability | Coupons | Not started |
| SUBS-025 | Billing Capabilities | capability | Promotional pricing | Not started |
| SUBS-026 | Billing Capabilities | capability | Regional pricing | Not started |
| SUBS-027 | Billing Capabilities | capability | Tax on subscriptions | Not started |
| SUBS-028 | Billing Capabilities | capability | Automated renewals | Not started |
| SUBS-029 | Billing Capabilities | capability | Payment failure handling | Not started |
| SUBS-030 | Billing Capabilities | capability | Dunning workflows | Not started |
| SUBS-031 | Billing Capabilities | capability | Subscription invoices | Not started |
| SUBS-032 | Billing Capabilities | rule | Maintain clear distinctions between platform subscription billing and customers' own accounting transactions | Not started |

## Platform super admin

Part 39 · M9 · priority P2 · depends on: SEC

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| ADMIN-001 |  | rule | Create a dedicated SaaS administration application | Tested |
| ADMIN-002 |  | capability | Tenant management | Tested |
| ADMIN-003 |  | capability | Organization management | Tested |
| ADMIN-004 |  | capability | User management | Tested |
| ADMIN-005 |  | capability | Subscription management | Not started |
| ADMIN-006 |  | capability | Plan management | Not started |
| ADMIN-007 |  | capability | Feature flags | Not started |
| ADMIN-008 |  | capability | AI usage monitoring | Not started |
| ADMIN-009 |  | capability | AI model configuration | Not started |
| ADMIN-010 |  | capability | API usage monitoring | Not started |
| ADMIN-011 |  | capability | Infrastructure monitoring | Not started |
| ADMIN-012 |  | capability | Support ticket management | Not started |
| ADMIN-013 |  | capability | Audit log search | Not started |
| ADMIN-014 |  | capability | Integration health | Not started |
| ADMIN-015 |  | capability | Billing management | Not started |
| ADMIN-016 |  | capability | Product analytics | Not started |
| ADMIN-017 |  | capability | Error monitoring | Not started |
| ADMIN-018 |  | capability | Security alerts | Not started |
| ADMIN-019 |  | capability | System announcements | Tested |
| ADMIN-020 |  | capability | Maintenance controls | Not started |
| ADMIN-021 |  | rule | Super Admin access must not automatically grant unrestricted access to tenant financial data | Tested |
| ADMIN-022 |  | rule | Implement controlled support access with explicit authorization, logging and expiration | Not started |

## Mobile experience

Part 40 · M8 · priority P3 · depends on: DS

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| MOB-001 |  | rule | Create a responsive web application first | Implementing |
| MOB-002 |  | rule | Then provide an architecture for dedicated mobile applications | Not started |
| MOB-003 |  | capability | Dashboard viewing | Not started |
| MOB-004 |  | capability | Invoice creation | Not started |
| MOB-005 |  | capability | Receipt capture | Not started |
| MOB-006 |  | capability | Expense submission | Not started |
| MOB-007 |  | capability | Approval management | Implementing |
| MOB-008 |  | capability | Payment status | Not started |
| MOB-009 |  | capability | Financial alerts | Not started |
| MOB-010 |  | capability | AI assistant | Not started |
| MOB-011 |  | capability | Document uploads | Not started |
| MOB-012 |  | capability | Customer statements | Not started |
| MOB-013 |  | capability | Vendor payments overview | Not started |
| MOB-014 |  | capability | Cash-flow monitoring | Not started |
| MOB-015 |  | rule | Provide biometric authentication where supported | Not started |
| MOB-016 |  | rule | Do not store sensitive financial data insecurely on devices | Not started |

## Performance and scalability

Part 41 · M9 · priority P1 · depends on: none

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| PERF-001 |  | capability | Thousands of organizations | Not started |
| PERF-002 |  | capability | Large transaction volumes | Not started |
| PERF-003 |  | capability | Concurrent users | Not started |
| PERF-004 |  | capability | Complex reporting | Not started |
| PERF-005 |  | capability | AI workload isolation | Not started |
| PERF-006 |  | capability | Background processing | Not started |
| PERF-007 |  | capability | Regional deployments | Implemented |
| PERF-008 |  | capability | Horizontal scaling | Not started |
| PERF-009 |  | capability | Database partitioning where justified | Not started |
| PERF-010 |  | capability | Caching | Not started |
| PERF-011 |  | capability | Read replicas | Not started |
| PERF-012 |  | capability | Efficient search | Not started |
| PERF-013 |  | capability | Asynchronous document processing | Not started |
| PERF-014 |  | rule | Establish measurable performance budgets | Not started |
| PERF-015 |  | capability | Typical dashboard interaction under two seconds under defined test conditions | Not started |
| PERF-016 |  | capability | Common API reads under 300 milliseconds at the 95th percentile under defined load | Not started |
| PERF-017 |  | capability | Financial posting with transactional consistency | Tested |
| PERF-018 |  | capability | No cross-tenant data exposure | Tested |
| PERF-019 |  | capability | Recoverable background jobs | Not started |
| PERF-020 |  | capability | Observable AI execution | Not started |
| PERF-021 |  | rule | Benchmark before claiming these targets are achieved | Not started |

## Testing and quality assurance

Part 42 · M1 · priority P0 · depends on: none

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| QA-001 |  | rule | Build automated testing from the beginning | Tested |
| QA-002 | Required Tests | capability | Unit tests | Tested |
| QA-003 | Required Tests | capability | Integration tests | Tested |
| QA-004 | Required Tests | capability | API tests | Tested |
| QA-005 | Required Tests | capability | End-to-end tests | Tested |
| QA-006 | Required Tests | capability | Accounting invariant tests | Tested |
| QA-007 | Required Tests | capability | Tax calculation tests | Not started |
| QA-008 | Required Tests | capability | Multi-currency tests | Tested |
| QA-009 | Required Tests | capability | Reconciliation tests | Tested |
| QA-010 | Required Tests | capability | Payroll calculation tests | Not started |
| QA-011 | Required Tests | capability | Financial reporting tests | Tested |
| QA-012 | Required Tests | capability | Permission tests | Tested |
| QA-013 | Required Tests | capability | Tenant isolation tests | Tested |
| QA-014 | Required Tests | capability | AI agent evaluation tests | Not started |
| QA-015 | Required Tests | capability | Prompt injection tests | Not started |
| QA-016 | Required Tests | capability | Workflow recovery tests | Not started |
| QA-017 | Required Tests | capability | Load tests | Not started |
| QA-018 | Required Tests | capability | Accessibility tests | Not started |
| QA-019 | Required Tests | capability | Visual regression tests | Not started |
| QA-020 | Required Tests | capability | Security tests | Not started |
| QA-021 | Financial Test Scenarios | capability | Every journal balances | Tested |
| QA-022 | Financial Test Scenarios | capability | Reversals preserve history | Tested |
| QA-023 | Financial Test Scenarios | capability | Closed periods reject unauthorized postings | Tested |
| QA-024 | Financial Test Scenarios | capability | Currency conversions use the correct rate and precision | Tested |
| QA-025 | Financial Test Scenarios | capability | Trial balance reconciles | Tested |
| QA-026 | Financial Test Scenarios | capability | Financial statements reconcile to the ledger | Tested |
| QA-027 | Financial Test Scenarios | capability | Duplicate requests do not duplicate postings | Tested |
| QA-028 | Financial Test Scenarios | capability | Concurrent operations preserve accounting consistency | Tested |
| QA-029 | Financial Test Scenarios | capability | Tax calculations use the correct effective-dated rules | Not started |
| QA-030 | Financial Test Scenarios | capability | Unauthorized AI agents cannot post entries or initiate payments | Not started |
| QA-031 | Financial Test Scenarios | rule | Use deterministic test fixtures | Implementing |

## Demonstration data

Part 43 · M1 · priority P1 · depends on: GL

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| DEMO-001 |  | rule | Create realistic synthetic demonstration organizations | Not started |
| DEMO-002 |  | capability | Indian consulting SME | Not started |
| DEMO-003 |  | capability | US professional services company | Not started |
| DEMO-004 |  | capability | UK trading business | Not started |
| DEMO-005 |  | capability | UAE multinational subsidiary | Not started |
| DEMO-006 |  | capability | Global manufacturing group | Not started |
| DEMO-007 |  | capability | Market research agency | Not started |
| DEMO-008 |  | capability | Customers | Not started |
| DEMO-009 |  | capability | Vendors | Not started |
| DEMO-010 |  | capability | Employees | Not started |
| DEMO-011 |  | capability | Invoices | Not started |
| DEMO-012 |  | capability | Bills | Not started |
| DEMO-013 |  | capability | Journal entries | Implementing |
| DEMO-014 |  | capability | Bank transactions | Not started |
| DEMO-015 |  | capability | Projects | Not started |
| DEMO-016 |  | capability | Budgets | Not started |
| DEMO-017 |  | capability | Tax records | Not started |
| DEMO-018 |  | capability | Financial reports | Not started |
| DEMO-019 |  | capability | AI recommendations | Not started |
| DEMO-020 |  | rule | Label all demonstration data as synthetic | Not started |
| DEMO-021 |  | rule | Do not imply the figures represent real organizations | Tested |

## Additional differentiating innovations

Part 44 · M7 · priority P3 · depends on: none

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| INNOV-001 | 44.1 Financial Knowledge Graph | rule | Connect customers, contracts, invoices, vendors, projects, payments, journal entries and risks in an explainable relationship graph | Implemented |
| INNOV-002 | 44.2 Financial Decision Memory | rule | Maintain a searchable history of approved management decisions, assumptions, financial outcomes and lessons learned | Tested |
| INNOV-003 | 44.3 AI Financial Policy Studio | rule | Allow organizations to define financial policies conversationally | Tested |
| INNOV-004 | 44.3 AI Financial Policy Studio | rule | Convert approved policies into testable, version-controlled workflow rules | Tested |
| INNOV-005 | 44.4 Continuous Financial Health Monitoring | rule | Evaluate financial indicators continuously and provide prioritized alerts | Tested |
| INNOV-006 | 44.5 Intelligent Financial Task Marketplace | rule | Provide a centralized queue of tasks generated by users, rules and AI agents | Tested |
| INNOV-007 | 44.6 Financial Data Lineage Explorer | rule | Allow users to trace any reported figure to its originating transactions and documents | Tested |
| INNOV-008 | 44.7 Cross-Functional Business Impact Engine | rule | Estimate how sales, HR, procurement and operational changes affect financial performance | Tested |
| INNOV-009 | 44.8 AI Financial Model Evaluation Lab | rule | Compare forecast models against historical outcomes and track accuracy | Tested |
| INNOV-010 | 44.9 Financial Disaster Simulation | rule | Simulate liquidity shocks, customer defaults, supplier failures and major operational disruptions | Tested |
| INNOV-011 | 44.10 Business Opportunity Intelligence | rule | Identify potentially profitable growth opportunities based on authorized financial and operational data | Tested |
| INNOV-012 | 44.11 Intelligent Financial Recovery Planning | rule | Generate evidence-based financial recovery scenarios | Tested |
| INNOV-013 | 44.12 Voice-Based Financial Assistant | rule | Allow authorized users to ask financial questions by voice | Integration pending |
| INNOV-014 | 44.12 Voice-Based Financial Assistant | rule | Require confirmation for sensitive actions | Tested |
| INNOV-015 | 44.13 AI-Generated Financial Dashboards | rule | Allow users to describe a dashboard in natural language | Tested |
| INNOV-016 | 44.13 AI-Generated Financial Dashboards | rule | Generate a validated dashboard configuration using approved metrics | Tested |
| INNOV-017 | 44.14 AI Financial Report Designer | rule | Generate report layouts and narrative summaries from user instructions | Tested |
| INNOV-018 | 44.15 Explainable Financial Benchmarking | rule | Compare company performance with properly anonymized, authorized benchmark datasets | Tested |

## Navigation structure

Part 45 · M1 · priority P1 · depends on: DS

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| NAV-001 |  | rule | Create a premium sidebar and global navigation system | Implementing |
| NAV-002 |  | capability | Overview | Implemented |
| NAV-003 |  | capability | Executive Command Center | Not started |
| NAV-004 |  | capability | AI Finance Copilot | Integration pending |
| NAV-005 |  | capability | Accounting | Implemented |
| NAV-006 |  | capability | General Ledger | Implemented |
| NAV-007 |  | capability | Accounts Receivable | Not started |
| NAV-008 |  | capability | Accounts Payable | Not started |
| NAV-009 |  | capability | Banking | Not started |
| NAV-010 |  | capability | Reconciliation | Implemented |
| NAV-011 |  | capability | Taxation | Not started |
| NAV-012 |  | capability | Payroll | Not started |
| NAV-013 |  | capability | Expenses | Not started |
| NAV-014 |  | capability | Procurement | Not started |
| NAV-015 |  | capability | Treasury | Not started |
| NAV-016 |  | capability | Financial Planning | Not started |
| NAV-017 |  | capability | Budgets | Not started |
| NAV-018 |  | capability | Forecasting | Not started |
| NAV-019 |  | capability | Financial Digital Twin | Not started |
| NAV-020 |  | capability | Financial War Room | Not started |
| NAV-021 |  | capability | Projects | Not started |
| NAV-022 |  | capability | Contracts | Not started |
| NAV-023 |  | capability | Customers | Not started |
| NAV-024 |  | capability | Vendors | Not started |
| NAV-025 |  | capability | Inventory Finance | Not started |
| NAV-026 |  | capability | Fixed Assets | Implemented |
| NAV-027 |  | capability | Multi-Entity Finance | Not started |
| NAV-028 |  | capability | Financial Consolidation | Not started |
| NAV-029 |  | capability | Reports | Implemented |
| NAV-030 |  | capability | Business Intelligence | Not started |
| NAV-031 |  | capability | Fraud and Risk | Not started |
| NAV-032 |  | capability | Compliance | Not started |
| NAV-033 |  | capability | Audit | Implemented |
| NAV-034 |  | capability | Documents | Not started |
| NAV-035 |  | capability | AI Agent Workforce | Not started |
| NAV-036 |  | capability | Automation Studio | Implementing |
| NAV-037 |  | capability | Financial Recovery | Not started |
| NAV-038 |  | capability | Financial Benchmarking | Not started |
| NAV-039 |  | capability | Integrations | Tested |
| NAV-040 |  | capability | Subscription Management | Not started |
| NAV-041 |  | capability | Organization Settings | Not started |
| NAV-042 |  | capability | User Management | Tested |
| NAV-043 |  | capability | Security Center | Not started |
| NAV-044 |  | capability | Support | Not started |
| NAV-045 |  | capability | Super Admin | Not started |
| NAV-046 |  | rule | Use nested navigation and progressive disclosure | Implemented |
| NAV-047 |  | rule | Do not overwhelm users by showing all modules simultaneously | Implemented |
| NAV-048 |  | rule | Allow organizations to enable only the modules relevant to them | Not started |

## Design system

Part 46 · M1 · priority P1 · depends on: none

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| DS-001 |  | rule | Create a reusable design system | Not started |
| DS-002 |  | capability | Navigation sidebar | Not started |
| DS-003 |  | capability | Command palette | Not started |
| DS-004 |  | capability | Global search | Not started |
| DS-005 |  | capability | Dashboard cards | Not started |
| DS-006 |  | capability | Financial KPI cards | Not started |
| DS-007 |  | capability | Data tables | Not started |
| DS-008 |  | capability | Advanced filters | Not started |
| DS-009 |  | capability | Charts | Not started |
| DS-010 |  | capability | Financial calculators | Not started |
| DS-011 |  | capability | Date selectors | Not started |
| DS-012 |  | capability | Currency selectors | Not started |
| DS-013 |  | capability | Multi-company selectors | Not started |
| DS-014 |  | capability | Approval dialogs | Implemented |
| DS-015 |  | capability | AI recommendation cards | Not started |
| DS-016 |  | capability | Agent status indicators | Not started |
| DS-017 |  | capability | Workflow builders | Not started |
| DS-018 |  | capability | Document viewers | Not started |
| DS-019 |  | capability | Notification center | Not started |
| DS-020 |  | capability | Financial alerts | Not started |
| DS-021 |  | capability | Audit timeline | Not started |
| DS-022 |  | capability | Scenario controls | Not started |
| DS-023 |  | capability | Report builders | Not started |
| DS-024 |  | capability | Form components | Not started |
| DS-025 |  | capability | Empty states | Not started |
| DS-026 |  | capability | Loading states | Not started |
| DS-027 |  | capability | Error states | Not started |
| DS-028 | Motion Design | rule | Use animation to improve comprehension | Not started |
| DS-029 | Motion Design | capability | Cash movement animation | Not started |
| DS-030 | Motion Design | capability | Financial chart transitions | Not started |
| DS-031 | Motion Design | capability | Risk alert transitions | Not started |
| DS-032 | Motion Design | capability | Workflow execution visualization | Not started |
| DS-033 | Motion Design | capability | Agent collaboration visualization | Not started |
| DS-034 | Motion Design | capability | Financial scenario updates | Not started |
| DS-035 | Motion Design | capability | Interactive drill-down transitions | Not started |
| DS-036 | Motion Design | rule | Avoid decorative animation that interferes with accounting work | Not started |

## Absolute quality rules

Part 50 · All · priority P0 · depends on: none

| ID | Section | Kind | Requirement | Status |
|---|---|---|---|---|
| RULE-001 |  | rule | Do not create fake functional buttons | Implemented |
| RULE-002 |  | rule | Do not create disconnected dashboards | Implemented |
| RULE-003 |  | rule | Do not substitute static cards for implemented business logic | Implemented |
| RULE-004 |  | rule | Do not invent financial data in production | Not started |
| RULE-005 |  | rule | Do not claim AI functionality when only a static response exists | Tested |
| RULE-006 |  | rule | Do not claim live banking integration without credentials and provider validation | Not started |
| RULE-007 |  | rule | Do not claim regulatory compliance without verification | Not started |
| RULE-008 |  | rule | Do not use insecure shortcuts | Not started |
| RULE-009 |  | rule | Do not store secrets in source code | Tested |
| RULE-010 |  | rule | Do not bypass tenant permissions | Tested |
| RULE-011 |  | rule | Do not permit unauthorized AI financial actions | Tested |
| RULE-012 |  | rule | Do not use floating-point arithmetic for financial postings | Tested |
| RULE-013 |  | rule | Do not modify historical posted transactions silently | Tested |
| RULE-014 |  | rule | Do not expose financial information across tenants | Tested |
| RULE-015 |  | rule | Do not skip tests for critical accounting functions | Tested |
| RULE-016 |  | rule | Do not conceal incomplete features | Tested |
| RULE-017 |  | rule | Do not implement proprietary competitor code | Not started |
| RULE-018 |  | rule | Do not over-engineer infrastructure unnecessarily | Not started |
| RULE-019 |  | rule | Do not sacrifice financial accuracy for visual effects | Not started |
| RULE-020 |  | rule | Do not prioritize cosmetic completeness over working accounting functionality | Not started |

